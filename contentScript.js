const BLOCKED_PATH_SEGMENTS = new Set([
  "",
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "search",
  "settings",
  "compose",
  "login",
  "logout",
  "tos",
  "privacy",
  "hashtag",
  "intent",
  "share",
  "jobs",
  "download",
  "account",
  "oauth"
]);
const STORAGE_KEY = "xUnfollowHelper";
const RELATIONSHIP_DETECTION_VERSION = 5;
const CALIBRATED_JOB_KEY = "xUnfollowHelperCalibratedScan";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function storageGet() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (value) => {
      resolve(value[STORAGE_KEY] || { accounts: {} });
    });
  });
}

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve);
  });
}

function getScrollElement() {
  return document.scrollingElement || document.documentElement || document.body;
}

function getScrollTop() {
  return getScrollElement().scrollTop || window.scrollY || 0;
}

function getMaxScrollTop() {
  const element = getScrollElement();
  return Math.max(0, element.scrollHeight - window.innerHeight);
}

function scrollToTop() {
  const element = getScrollElement();
  element.scrollTo({ top: 0, behavior: "auto" });
  window.scrollTo({ top: 0, behavior: "auto" });
}

function scrollByAmount(amount, behavior = "smooth") {
  const element = getScrollElement();
  const nextTop = Math.max(0, Math.min(getMaxScrollTop(), getScrollTop() + amount));
  element.scrollTo({ top: nextTop, behavior });
  window.scrollTo({ top: nextTop, behavior });
}

function normalizeHandle(value) {
  return String(value || "").replace(/^@+/, "").trim().toLowerCase();
}

function usersToObject(users = []) {
  return Object.fromEntries(
    users
      .filter((user) => user?.handle)
      .map((user) => [normalizeHandle(user.handle), { ...user, handle: normalizeHandle(user.handle) }])
  );
}

function extractHandleFromHref(href) {
  try {
    const url = new URL(href, location.origin);
    if (!["x.com", "twitter.com", location.hostname].includes(url.hostname)) {
      return "";
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) {
      return "";
    }

    const handle = normalizeHandle(parts[0]);
    if (!handle || BLOCKED_PATH_SEGMENTS.has(handle) || !/^[a-z0-9_]{1,15}$/i.test(handle)) {
      return "";
    }

    return handle;
  } catch {
    return "";
  }
}

function isVisibleElement(element) {
  const rect = element?.getBoundingClientRect?.();
  return Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight
  );
}

function findProfileAnchor(root, preferredHandle = "") {
  const anchors = [...root.querySelectorAll('a[href]')];
  const parsed = anchors
    .map((anchor) => ({ anchor, handle: extractHandleFromHref(anchor.getAttribute("href")) }))
    .filter((item) => item.handle);

  if (preferredHandle) {
    return parsed.find((item) => item.handle === preferredHandle)?.anchor || null;
  }

  return parsed[0]?.anchor || null;
}

function getAnchorContext(anchor) {
  let node = anchor;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const text = textFromNode(node);
    if (text.includes("@") && text.length <= 220) {
      return node;
    }
    node = node.parentElement;
  }
  return anchor.parentElement || anchor;
}

function inferUserCellFromAnchor(anchor, handle) {
  const preferred = anchor.closest?.('[data-testid="UserCell"], [data-testid="cellInnerDiv"], [role="listitem"], article');
  if (preferred && isVisibleElement(preferred)) {
    return preferred;
  }

  let best = null;
  let node = anchor.parentElement;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const rect = node.getBoundingClientRect?.();
    const text = textFromNode(node);
    const hasHandle = text.toLowerCase().includes(`@${handle}`);
    const reasonableRow = rect && rect.width >= 260 && rect.height >= 42 && rect.height <= 420;

    if (hasHandle && reasonableRow && isVisibleElement(node)) {
      best = node;
      if (/正在关注|Following|Follow|关注了你|Follows you/i.test(text)) {
        break;
      }
    }

    node = node.parentElement;
  }

  return best;
}

function getProfileAndListType() {
  const parts = location.pathname.split("/").filter(Boolean);
  const profile = normalizeHandle(parts[0]);
  const last = parts[parts.length - 1] || "";
  const listType = last === "followers" || last === "verified_followers"
    ? "followers"
    : last === "following"
      ? "following"
      : "";

  if (!profile || BLOCKED_PATH_SEGMENTS.has(profile)) {
    return { profile: "", listType: "" };
  }

  return { profile, listType };
}

function textFromNode(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function normalizeRelationshipText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isFollowsYouLabel(value) {
  const text = normalizeRelationshipText(value);
  return [
    "follows you",
    "关注了你",
    "关注你",
    "跟随了你",
    "跟隨了你",
    "跟隨你",
    "正在跟隨你"
  ].includes(text);
}

function centerY(rect) {
  return (rect.top + rect.bottom) / 2;
}

function detectNearbyFollowsYouLabel(cell, handleAnchor) {
  if (!cell || !handleAnchor) {
    return null;
  }

  const handleRect = handleAnchor.getBoundingClientRect?.();
  const cellRect = cell.getBoundingClientRect?.();
  if (!handleRect || !cellRect) {
    return null;
  }

  const nodes = [...cell.querySelectorAll("span, div")];
  for (const node of nodes) {
    const label = textFromNode(node);
    if (!isFollowsYouLabel(label)) {
      continue;
    }

    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const nearHandleLine = Math.abs(centerY(rect) - centerY(handleRect)) <= 46;
    const nearHandleX = rect.left >= handleRect.left - 90 && rect.left <= handleRect.right + 320;
    const inUserHeader = rect.top - cellRect.top <= 118;
    if ((nearHandleLine && nearHandleX) || inUserHeader) {
      return { followsYou: true, label, source: "near-handle-label" };
    }
  }

  return null;
}

function detectFollowsYou(cell, nameBlock, handle, handleAnchor = null) {
  const nearby = detectNearbyFollowsYouLabel(cell, handleAnchor);
  if (nearby) {
    return nearby;
  }

  const relationshipRoot = nameBlock || (handleAnchor ? getAnchorContext(handleAnchor) : null);

  if (!relationshipRoot) {
    return { followsYou: false, label: "", source: "missing-name-block" };
  }

  const textNodes = [
    ...relationshipRoot.querySelectorAll("span, div")
  ];

  for (const node of textNodes) {
    const label = textFromNode(node);
    if (isFollowsYouLabel(label)) {
      return { followsYou: true, label, source: "username-area-label" };
    }

    for (const attrName of ["aria-label", "title"]) {
      const attr = node.getAttribute?.(attrName);
      if (isFollowsYouLabel(attr)) {
        return { followsYou: true, label: attr, source: `username-area-${attrName}` };
      }
    }
  }

  const nameText = textFromNode(relationshipRoot);
  const normalizedNameText = normalizeRelationshipText(nameText);
  const handleToken = `@${normalizeHandle(handle)}`;
  const handleIndex = normalizedNameText.indexOf(handleToken);
  const textAfterHandle = handleIndex >= 0 ? normalizedNameText.slice(handleIndex + handleToken.length) : "";
  if (/(关注了你|关注你|follows you)/i.test(textAfterHandle)) {
    return { followsYou: true, label: textAfterHandle.includes("关注了你") ? "关注了你" : "Follows you", source: "username-area-after-handle" };
  }

  return { followsYou: false, label: "", source: nameBlock ? "username-area-absent" : "anchor-context-absent" };
}

function normalizeCountText(value) {
  return String(value || "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ",")
    .replace(/．/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDisplayedCountToken(token) {
  const raw = normalizeCountText(token);
  const compact = raw.replace(/[,\s]/g, "");
  const match = compact.match(/^(\d+(?:\.\d+)?)([KkMm]|万|千)?$/);

  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  if (!Number.isFinite(number)) {
    return null;
  }

  const suffix = match[2] || "";
  const multiplier = suffix === "万"
    ? 10000
    : suffix === "千" || suffix.toLowerCase() === "k"
      ? 1000
      : suffix.toLowerCase() === "m"
        ? 1000000
        : 1;

  return {
    value: Math.round(number * multiplier),
    raw,
    exact: !suffix && !compact.includes(".")
  };
}

function parseFollowingCountFromText(text) {
  const normalized = normalizeCountText(text);
  const numberToken = "([0-9][0-9,.\\s]*\\s*(?:[KkMm]|万|千)?)";
  const patterns = [
    new RegExp(`${numberToken}\\s*(?:Following|正在关注|关注中|关注了)`, "i"),
    new RegExp(`(?:Following|正在关注|关注中|关注了)\\s*${numberToken}`, "i")
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const parsed = match ? parseDisplayedCountToken(match[1]) : null;
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function readFollowingCount(profile) {
  const candidates = [];

  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      const url = new URL(anchor.getAttribute("href"), location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      if (normalizeHandle(parts[0]) !== profile || parts[1] !== "following") {
        continue;
      }

      const parsed = parseFollowingCountFromText([
        textFromNode(anchor),
        anchor.getAttribute("aria-label"),
        anchor.getAttribute("title")
      ].filter(Boolean).join(" "));
      if (parsed) {
        candidates.push({ ...parsed, source: "profile-following-link", score: parsed.exact ? 120 : 100 });
      }
    } catch {
      // Ignore malformed href values from the page.
    }
  }

  const bodyParsed = parseFollowingCountFromText(document.body?.innerText || "");
  if (bodyParsed) {
    candidates.push({ ...bodyParsed, source: "page-text", score: bodyParsed.exact ? 40 : 20 });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best
    ? { value: best.value, raw: best.raw, exact: best.exact, source: best.source, capturedAt: new Date().toISOString() }
    : null;
}

function parseUserCell(cell) {
  const nameBlock = cell.querySelector('[data-testid="User-Name"]');
  const nameAnchors = nameBlock ? [...nameBlock.querySelectorAll('a[href]')] : [];
  const cellAnchors = [...cell.querySelectorAll('a[href]')];
  const anchors = nameAnchors.length ? nameAnchors : cellAnchors;
  const handles = anchors
    .map((anchor) => extractHandleFromHref(anchor.getAttribute("href")))
    .filter(Boolean);
  const handle = handles.find(Boolean);

  if (!handle) {
    return null;
  }

  const handleAnchor = (nameBlock ? findProfileAnchor(nameBlock, handle) : null) || findProfileAnchor(cell, handle);
  const fallbackNameBlock = nameBlock || cell;
  const relationshipRoot = nameBlock || (handleAnchor ? getAnchorContext(handleAnchor) : fallbackNameBlock);
  const rawText = textFromNode(relationshipRoot);
  const relationship = detectFollowsYou(cell, nameBlock, handle, handleAnchor);
  const displayName = rawText
    .split("@")[0]
    .replace(/Follow|Following|Follows you|关注了你|关注你|关注|正在关注/g, "")
    .trim();

  return {
    handle,
    displayName: displayName || `@${handle}`,
    profileUrl: `https://${location.hostname}/${handle}`,
    followsYou: relationship.followsYou,
    followsYouLabel: relationship.label,
    followsYouSource: relationship.source,
    relationshipDetectionVersion: RELATIONSHIP_DETECTION_VERSION,
    nameAreaText: textFromNode(relationshipRoot).slice(0, 240),
    capturedAt: new Date().toISOString()
  };
}

function getUserCellCandidates() {
  const main = document.querySelector("main") || document.body;
  const byElement = new Map();
  const addCell = (cell, source) => {
    if (!cell || !isVisibleElement(cell) || !findProfileAnchor(cell)) {
      return;
    }
    byElement.set(cell, source);
  };

  for (const cell of main.querySelectorAll('[data-testid="UserCell"], [data-testid="cellInnerDiv"], [role="listitem"], article')) {
    addCell(cell, "structured-cell");
  }

  if (byElement.size > 0) {
    return [...byElement.keys()];
  }

  for (const anchor of main.querySelectorAll('a[href]')) {
    const handle = extractHandleFromHref(anchor.getAttribute("href"));
    if (!handle || !isVisibleElement(anchor)) {
      continue;
    }

    const inferredCell = inferUserCellFromAnchor(anchor, handle);
    addCell(inferredCell, "anchor-inferred-cell");
  }

  return [...byElement.keys()];
}

function collectVisibleUsers() {
  const { profile, listType } = getProfileAndListType();
  const candidates = getUserCellCandidates();

  const byHandle = new Map();
  for (const cell of candidates) {
    const user = parseUserCell(cell);
    if (user && user.handle !== profile) {
      byHandle.set(user.handle, user);
    }
  }

  return {
    profile,
    listType,
    url: location.href,
    scanMode: "visible",
    isFullScan: false,
    relationshipDetectionVersion: RELATIONSHIP_DETECTION_VERSION,
    expectedFollowingCount: listType === "following" ? readFollowingCount(profile) : null,
    candidateCount: candidates.length,
    users: [...byHandle.values()]
  };
}

async function scanWithAutoScroll(options = {}, postProgress = () => {}, shouldStop = () => false) {
  const initialState = getProfileAndListType();
  const maxSeconds = Math.max(10, Math.min(Number(options.maxSeconds || 300), 1200));
  const maxQuietRounds = Math.max(3, Math.min(Number(options.maxQuietRounds || 28), 80));
  const maxBottomStableRounds = Math.max(2, Math.min(Number(options.maxBottomStableRounds || 6), 20));
  const startedAt = Date.now();
  const byHandle = new Map();
  let quietRounds = 0;
  let lastCount = 0;
  let lastScrollTop = -1;
  let lastScrollHeight = 0;
  let stallRounds = 0;
  let bottomStableRounds = 0;
  let stopReason = "time_limit";
  let maxCandidateCount = 0;

  scrollToTop();
  await sleep(1200);
  const expectedFollowingCount = initialState.listType === "following"
    ? (options.expectedFollowingCount || readFollowingCount(initialState.profile))
    : null;

  postProgress({
    phase: "count",
    count: 0,
    quietRounds: 0,
    maxQuietRounds,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    expectedFollowingCount
  });

  while ((Date.now() - startedAt) / 1000 < maxSeconds) {
    if (shouldStop()) {
      stopReason = "cancelled";
      break;
    }

    const previousCount = lastCount;
    const visible = collectVisibleUsers();
    maxCandidateCount = Math.max(maxCandidateCount, Number(visible.candidateCount || 0));
    for (const user of visible.users) {
      byHandle.set(user.handle, user);
    }

    const scrollTop = getScrollTop();
    const scrollHeight = getScrollElement().scrollHeight || document.body.scrollHeight || 0;
    const maxScrollTop = getMaxScrollTop();
    const nearBottom = maxScrollTop > 0 && maxScrollTop - scrollTop < Math.max(500, window.innerHeight * 0.6);
    const scrollMoved = Math.abs(scrollTop - lastScrollTop) > 20;
    const scrollHeightStable = Math.abs(scrollHeight - lastScrollHeight) < 40;
    const foundNewUsers = byHandle.size > previousCount;
    const expectedReached = Boolean(
      expectedFollowingCount?.exact &&
      Number.isFinite(expectedFollowingCount.value) &&
      byHandle.size >= expectedFollowingCount.value
    );

    if (foundNewUsers) {
      quietRounds = 0;
      lastCount = byHandle.size;
    } else {
      quietRounds += 1;
    }

    if (!scrollMoved && !foundNewUsers) {
      stallRounds += 1;
    } else {
      stallRounds = 0;
    }

    if (nearBottom && !foundNewUsers && scrollHeightStable) {
      bottomStableRounds += 1;
    } else if (!nearBottom || foundNewUsers) {
      bottomStableRounds = 0;
    }
    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;

    postProgress({
      count: byHandle.size,
      quietRounds,
      maxQuietRounds,
      bottomStableRounds,
      maxBottomStableRounds,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      scrollPercent: maxScrollTop ? Math.min(100, Math.round((scrollTop / maxScrollTop) * 100)) : 0,
      nearBottom,
      expectedFollowingCount,
      expectedReached
    });

    if (expectedReached) {
      stopReason = "expected_count_reached";
      break;
    }

    if (nearBottom && bottomStableRounds >= maxBottomStableRounds) {
      stopReason = "bottom_reached";
      break;
    }

    if (quietRounds >= maxQuietRounds) {
      stopReason = "quiet_timeout";
      break;
    }

    if (quietRounds > 0 && quietRounds % 7 === 0) {
      scrollByAmount(-Math.max(240, Math.floor(window.innerHeight * 0.32)), "auto");
      await sleep(700);
      if (shouldStop()) {
        stopReason = "cancelled";
        break;
      }
      scrollByAmount(Math.max(820, Math.floor(window.innerHeight * 1.05)), "smooth");
      await sleep(1800);
      continue;
    }

    if (stallRounds >= 4 || nearBottom) {
      scrollByAmount(-Math.max(160, Math.floor(window.innerHeight * 0.22)), "auto");
      await sleep(500);
    }

    scrollByAmount(Math.max(620, Math.floor(window.innerHeight * 0.74)), "smooth");
    await sleep(1550);
  }

  const state = getProfileAndListType();
  return {
    ...state,
    url: location.href,
    scanMode: "auto",
    isFullScan: true,
    stopReason,
    relationshipDetectionVersion: RELATIONSHIP_DETECTION_VERSION,
    expectedFollowingCount,
    candidateCount: maxCandidateCount,
    users: [...byHandle.values()],
    scannedAt: new Date().toISOString()
  };
}

function buildCountCheck(listType, snapshotCount, expectedFollowingCount, isFullScan) {
  if (listType !== "following" || !isFullScan) {
    return { status: "not_applicable" };
  }

  if (!expectedFollowingCount || !Number.isFinite(expectedFollowingCount.value)) {
    return { status: "unknown", actual: snapshotCount, message: "未读取到页面上的关注总数。" };
  }

  const expected = Number(expectedFollowingCount.value);
  const diff = snapshotCount - expected;
  if (!expectedFollowingCount.exact) {
    return { status: "approximate", expected, expectedRaw: expectedFollowingCount.raw, actual: snapshotCount, diff };
  }
  if (snapshotCount === expected) {
    return { status: "matched", expected, expectedRaw: expectedFollowingCount.raw, actual: snapshotCount, diff };
  }

  const tolerance = Math.max(1, Math.min(10, Math.ceil(expected * 0.003)));
  if (Math.abs(diff) <= tolerance) {
    return { status: "near_match", expected, expectedRaw: expectedFollowingCount.raw, actual: snapshotCount, diff, tolerance };
  }

  return { status: "mismatch", expected, expectedRaw: expectedFollowingCount.raw, actual: snapshotCount, diff };
}

function countNonMutualUsers(users = {}) {
  return Object.values(users).filter((user) => user.followsYou === false).length;
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

async function saveFollowingSnapshotLocally(scanData) {
  const profile = normalizeHandle(scanData.profile);
  const users = usersToObject(scanData.users);
  const snapshotCount = Object.keys(users).length;
  const countCheck = buildCountCheck("following", snapshotCount, scanData.expectedFollowingCount, true);
  const data = await storageGet();
  const account = ensureAccount(data, profile);
  const snapshot = {
    type: "following",
    users,
    count: snapshotCount,
    capturedAt: scanData.scannedAt || nowIso(),
    url: scanData.url || location.href,
    scanMode: "calibrated",
    isFullScan: true,
    stopReason: scanData.stopReason || "",
    relationshipDetectionVersion: RELATIONSHIP_DETECTION_VERSION,
    expectedFollowingCount: scanData.expectedFollowingCount || null,
    candidateCount: scanData.candidateCount ?? null,
    countCheck
  };

  if (snapshotCount > 0) {
    account.last.following = snapshot;
  }

  account.history.unshift({
    type: "following",
    count: snapshot.count,
    capturedAt: snapshot.capturedAt,
    url: snapshot.url,
    expectedFollowingCount: countCheck.expected ?? null,
    countCheckStatus: countCheck.status
  });
  account.history = account.history.slice(0, 8);
  await storageSet(data);

  return {
    saved: snapshotCount > 0,
    count: snapshotCount,
    nonMutualCount: countNonMutualUsers(users),
    countCheck
  };
}

function getCalibratedJob() {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    return JSON.parse(sessionStorage.getItem(CALIBRATED_JOB_KEY) || "null");
  } catch {
    return null;
  }
}

function setCalibratedJob(job) {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  sessionStorage.setItem(CALIBRATED_JOB_KEY, JSON.stringify(job));
}

function clearCalibratedJob() {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  sessionStorage.removeItem(CALIBRATED_JOB_KEY);
}

async function waitForFollowingCount(profile, timeoutMs = 9000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = readFollowingCount(profile);
    if (last?.value) return last;
    await sleep(500);
  }
  return last;
}

function goToProfileHome(profile) {
  location.assign(`https://${location.hostname}/${profile}`);
}

function goToFollowingPage(profile) {
  location.assign(`https://${location.hostname}/${profile}/following`);
}

async function resumeCalibratedScanJob() {
  const job = getCalibratedJob();
  if (!job?.profile) {
    return;
  }

  const profile = normalizeHandle(job.profile);
  const state = getProfileAndListType();

  if (job.phase === "home") {
    if (state.profile !== profile || state.listType) {
      goToProfileHome(profile);
      return;
    }

    await sleep(1200);
    const expectedFollowingCount = await waitForFollowingCount(profile);
    setCalibratedJob({
      ...job,
      phase: "following",
      expectedFollowingCount,
      homeReadAt: nowIso()
    });
    goToFollowingPage(profile);
    return;
  }

  if (job.phase === "following") {
    if (state.profile !== profile || state.listType !== "following") {
      goToFollowingPage(profile);
      return;
    }

    try {
      await sleep(1800);
      const data = await scanWithAutoScroll({
        maxSeconds: 1200,
        maxQuietRounds: 70,
        maxBottomStableRounds: 12,
        expectedFollowingCount: job.expectedFollowingCount || null
      });
      const result = await saveFollowingSnapshotLocally({
        ...data,
        profile,
        expectedFollowingCount: job.expectedFollowingCount || data.expectedFollowingCount
      });
      clearCalibratedJob();

      if (!result.saved) {
        window.alert(`没有识别到用户行：页面关注人数 ${result.countCheck.expected || "未知"}，本次快照 0。请刷新页面后重试。`);
        return;
      }

      const expected = result.countCheck.expected ?? "未知";
      const actual = result.count;
      const diffText = Number.isFinite(result.countCheck.diff) && result.countCheck.diff !== 0
        ? `\n页面关注人数 ${expected}，本次快照 ${actual}，差异 ${result.countCheck.diff > 0 ? "+" : ""}${result.countCheck.diff}。`
        : "";
      window.alert(`已完成扫描~喵~\n当前未互关 ${result.nonMutualCount} 人。${diffText}`);
    } catch (error) {
      clearCalibratedJob();
      window.alert(`校准扫描失败：${String(error?.message || error)}`);
    }
  }
}

function startCalibratedFollowingScan(profile) {
  const normalizedProfile = normalizeHandle(profile || getProfileAndListType().profile);
  if (!normalizedProfile) {
    window.alert("没有识别到目标账号。请先打开账号页面或输入账号。");
    return;
  }

  setCalibratedJob({
    profile: normalizedProfile,
    phase: "home",
    startedAt: nowIso()
  });
  goToProfileHome(normalizedProfile);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "COLLECT_VISIBLE_USERS") {
    sendResponse({ ok: true, data: collectVisibleUsers() });
    return true;
  }

  if (message?.type === "START_CALIBRATED_FOLLOWING_SCAN") {
    startCalibratedFollowingScan(message.profile);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

if (typeof sessionStorage !== "undefined") {
  setTimeout(() => {
    resumeCalibratedScanJob();
  }, 800);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "x-list-scan") {
    return;
  }

  let disconnected = false;
  const markDisconnected = () => {
    disconnected = true;
  };

  window.addEventListener("beforeunload", markDisconnected, { once: true });
  port.onDisconnect.addListener(() => {
    markDisconnected();
  });

  function safePostMessage(payload) {
    if (disconnected) {
      return false;
    }

    try {
      port.postMessage(payload);
      return true;
    } catch {
      disconnected = true;
      return false;
    }
  }

  port.onMessage.addListener(async (message) => {
    if (message?.type !== "START_SCAN") {
      return;
    }

    try {
      const data = await scanWithAutoScroll(message.options, (progress) => {
        safePostMessage({ type: "PROGRESS", progress });
      }, () => disconnected);
      safePostMessage({ type: "DONE", ok: true, data });
    } catch (error) {
      if (!disconnected) {
        safePostMessage({ type: "DONE", ok: false, error: String(error?.message || error) });
      }
    }
  });
});
