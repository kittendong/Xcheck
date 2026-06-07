# GitHub 上传指南

请不要把 GitHub 密码发给任何人或任何聊天工具。GitHub 推送代码推荐使用浏览器登录、GitHub CLI、GitHub Desktop 或 Personal Access Token。

## 推荐仓库名

```text
x-non-mutual-checker
```

## 方法一：GitHub 网页上传

1. 登录 GitHub。
2. 点击右上角 `+`，选择 `New repository`。
3. Repository name 填：`x-non-mutual-checker`。
4. 选择 `Public`。
5. 不要勾选自动创建 README、.gitignore、License，本项目已经包含。
6. 创建仓库后，选择 `uploading an existing file`。
7. 上传本目录下所有文件。

## 方法二：本地 Git 推送

先在 GitHub 创建空仓库，然后在本项目目录执行：

```bash
git remote add origin https://github.com/<你的GitHub用户名>/x-non-mutual-checker.git
git push -u origin main
```

如果 Git 要求登录，请使用 Git Credential Manager 的浏览器登录流程，或使用 Personal Access Token。不要在命令行或聊天里明文输入密码。

## 方法三：安装 GitHub CLI

```bash
winget install GitHub.cli
gh auth login
gh repo create x-non-mutual-checker --public --source . --remote origin --push
```

`gh auth login` 会走浏览器认证，不需要把密码交给别人。
