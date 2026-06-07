# Contributing

欢迎提交 issue 和 pull request。

## 开发流程

1. 修改代码。
2. 运行测试：

```bash
node tests/relationship-detection.test.js
node --check contentScript.js
node --check popup.js
node --check background.js
```

3. 在 Chrome / Edge 的扩展管理页重新加载扩展。
4. 在 X/Twitter 页面手动验证。

## 维护重点

- X/Twitter DOM 结构变化时，优先修复 `contentScript.js` 的用户行定位和 `关注了你` 识别逻辑。
- 不加入自动取关功能。
- 不上传用户数据。
