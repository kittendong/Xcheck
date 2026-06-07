# 开源说明

本项目以 MIT License 开源。源码未压缩、未混淆，可以直接发布到 GitHub、Gitee 或其他代码托管平台。

## 目录

- `manifest.json`：Chrome / Edge 扩展配置。
- `background.js`：扩展角标提示。
- `contentScript.js`：X/Twitter 页面采集、滚动扫描、人数读取、未互关识别。
- `popup.html`：扩展弹窗结构。
- `popup.css`：扩展弹窗样式。
- `popup.js`：快照存储、数量核对、未互关统计。
- `icons/`：扩展图标和小猫 LOGO。
- `tests/`：本地逻辑测试。
- `README.md`：安装和使用说明。
- `LICENSE`：MIT 开源许可证。

## 发布建议

1. 新建公开仓库。
2. 上传本目录下所有文件。
3. 在仓库描述中说明：本扩展只在本地浏览器保存快照，不读取密码，不自动点击取关。
4. 如果发布到 Chrome Web Store，建议补充隐私政策，说明仅使用 `chrome.storage.local` 本地保存数据。
