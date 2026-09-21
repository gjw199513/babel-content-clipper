# Release 发布清单

本项目的普通用户安装入口是 Release 附件，不要求下载源码或运行构建命令。

## 用户需要下载什么

- 只使用浏览器采集：下载 `babel-content-clipper-extension-<version>.zip`。
- 还要连接本地 MCP：同时下载 `babel-content-clipper-<version>.tgz`。
- `babel-content-clipper-release-notes-<version>.md` 包含五种语言的安装摘要。
- `SHA256SUMS` 用于核对下载文件。

Chrome / Chromium 不支持直接加载普通 ZIP。用户下载后只需解压，在扩展管理页开启开发者模式，再通过“加载已解压的扩展程序”选择包含 `manifest.json` 的目录。扩展 ZIP 的根目录已经直接包含 `manifest.json`，没有多余的源码目录层级。

真正的一键安装需要发布到 Chrome Web Store，或使用浏览器认可的企业分发渠道。普通网站或 GitHub Release 上的自签名 CRX 不能作为通用 Chrome 安装方案，因此当前 Release 不生成会造成误解的 CRX。

## 发布者操作

版本号以 `package.json` 为发布源，扩展清单会分别写入浏览器接受的 `version` 和完整的 `version_name`。准备 Release 前执行：

```sh
npm run check
npm run verify:install
npm run package:release
```

`npm run package:release` 会生成并验证：

```text
release/babel-content-clipper-extension-<version>.zip
release/babel-content-clipper-<version>.tgz
release/babel-content-clipper-release-notes-<version>.md
release/babel-content-clipper-release-<version>.json
release/source-manifest.json
release/SHA256SUMS
```

在 [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases) 创建与版本一致的 Release，例如 `v0.1.1`。至少上传扩展 ZIP、对应 release notes 和 `SHA256SUMS`；若该版本支持 MCP 完整链路，再上传 tgz。上传后应从 Release 页面重新下载 ZIP，核对校验和，并确认解压目录根部存在 `manifest.json`。

脚本只准备本地发布附件，不会自动上传、创建远程 Release 或推送代码。
