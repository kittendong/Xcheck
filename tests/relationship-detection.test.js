const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeNode {
  constructor({ tag = "div", text = "", attrs = {}, children = [], rect = { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 } } = {}) {
    this.tag = tag;
    this._text = text;
    this.attrs = attrs;
    this.children = children;
    this.rect = rect;
  }

  get textContent() {
    return [this._text, ...this.children.map((child) => child.textContent)].join(" ");
  }

  getAttribute(name) {
    return this.attrs[name] || null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const result = [];
    const matches = (node) => {
      if (selector === 'a[href]') return node.tag === "a" && Boolean(node.attrs.href);
      if (selector === 'span, div') return node.tag === "span" || node.tag === "div";
      if (selector === '[data-testid="User-Name"]') return node.attrs["data-testid"] === "User-Name";
      if (selector === '[data-testid="UserCell"]') return node.attrs["data-testid"] === "UserCell";
      return false;
    };

    const visit = (node) => {
      if (matches(node)) result.push(node);
      for (const child of node.children) visit(child);
    };

    for (const child of this.children) visit(child);
    return result;
  }
}

function span(text, attrs = {}, rect) {
  return new FakeNode({ tag: "span", text, attrs, rect });
}

function link(href, text, rect = { top: 24, bottom: 44, left: 100, right: 200, width: 100, height: 20 }) {
  return new FakeNode({ tag: "a", text, attrs: { href }, rect });
}

function userCell({ displayName, handle, followsYouLabel = "", followsYouLabelOutside = "", bio = "", button = "正在关注" }) {
  const userNameChildren = [
    span(displayName),
    link(`/${handle}`, `@${handle}`)
  ];
  if (followsYouLabel) {
    userNameChildren.push(span(followsYouLabel));
  }

  return new FakeNode({
    attrs: { "data-testid": "UserCell" },
    rect: { top: 0, bottom: 180, left: 0, right: 600, width: 600, height: 180 },
    children: [
      new FakeNode({ attrs: { "data-testid": "User-Name" }, children: userNameChildren }),
      followsYouLabelOutside ? span(followsYouLabelOutside, {}, { top: 24, bottom: 44, left: 210, right: 290, width: 80, height: 20 }) : new FakeNode({ rect: { top: 80, bottom: 81, left: 0, right: 1, width: 1, height: 1 } }),
      span(bio),
      new FakeNode({ tag: "button", text: button })
    ]
  });
}

const context = {
  URL,
  location: { origin: "https://x.com", hostname: "x.com", pathname: "/kittendong/following", href: "https://x.com/kittendong/following" },
  window: { addEventListener() {}, innerHeight: 900, scrollTo() {}, scrollBy() {} },
  document: { querySelectorAll() { return []; }, body: { innerText: "" }, documentElement: {}, scrollingElement: { scrollTop: 0, scrollHeight: 0, scrollTo() {} } },
  chrome: { runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } } },
  setTimeout,
  clearTimeout
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf8"), context);

const mutual = context.parseUserCell(userCell({
  displayName: "Baybie_Nicka",
  handle: "Baybie_Nicka",
  followsYouLabel: "关注了你",
  bio: "土狗 | 擼毛 | 链游",
  button: "正在关注"
}));
assert.strictEqual(mutual.handle, "baybie_nicka");
assert.strictEqual(mutual.followsYou, true);

const mutualOutsideNameBlock = context.parseUserCell(userCell({
  displayName: "Truth&Risk",
  handle: "freexiao84",
  followsYouLabelOutside: "关注了你",
  bio: "财经 | 交易 | 杂谈",
  button: "正在关注"
}));
assert.strictEqual(mutualOutsideNameBlock.handle, "freexiao84");
assert.strictEqual(mutualOutsideNameBlock.followsYou, true);

const oneWay = context.parseUserCell(userCell({
  displayName: "梦之星推广",
  handle: "ehmb7r",
  bio: "专业打造Web3链上工具",
  button: "正在关注"
}));
assert.strictEqual(oneWay.handle, "ehmb7r");
assert.strictEqual(oneWay.followsYou, false);

const bioNoise = context.parseUserCell(userCell({
  displayName: "Noise",
  handle: "noise_user",
  bio: "这里故意写关注了你，但这不是用户名区域标签",
  button: "正在关注"
}));
assert.strictEqual(bioNoise.followsYou, false);

console.log("relationship detection tests passed");
