# 安装与首次连接

[简体中文](install.md) · [English](i18n/en/install.md) · [繁體中文](i18n/zh-TW/install.md) · [日本語](i18n/ja/install.md) · [한국어](i18n/ko/install.md)

本说明使用 `0.1.0-alpha.1` 的命令行接口。实际验证的系统、浏览器及客户端见 [兼容矩阵](compatibility.md)；当前为开发候选版本，尚未发布到 npm。

## 1. 下载发布包或准备源码

普通用户优先从对应版本的 [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases) 下载 `babel-content-clipper-extension-0.1.0-alpha.1.zip`，解压到一个长期保留的目录。只使用浏览器采集时，不需要下载源码、安装 Node.js 或自行构建。

需要连接本地 MCP 时，再下载同一 Release 中的 `babel-content-clipper-0.1.0-alpha.1.tgz`。本地组件需要 Node.js 22 或更新版本，请确认 `node --version` 能正常运行。浏览器采集本身不依赖 FFmpeg；Agent 需要裁切音视频时，再使用其执行环境中已有的媒体工具。

从源码目录构建：

```sh
npm ci
npm run build
```

使用 Release 中的 MCP 安装包时，在自己的安装目录执行下面的命令。请将文件名替换为实际下载的安装包路径。

```sh
npm install /absolute/path/babel-content-clipper-0.1.0-alpha.1.tgz
```

源码方式的本地组件位于 `dist/node/cli.js`，安装包方式位于 `node_modules/babel-content-clipper/dist/node/cli.js`。下文使用源码方式的相对路径；执行命令时停留在源码根目录。

## 2. 加载扩展并取得连接标识

在浏览器扩展管理页开启开发者模式，选择“加载已解压的扩展程序”：源码方式选择 `dist/extension`，Release 方式选择包含 `manifest.json` 的 ZIP 解压目录。Chrome 不能直接加载普通 ZIP；无需源码，但需要先解压。真正的一键安装需要浏览器商店或浏览器认可的企业分发渠道。

打开 Babel 侧栏，点击“展开管理”进入素材库，再打开“连接与设置”。复制显示的浏览器连接标识 `profileId`。它区分不同浏览器数据，不是网站账号。

该构建的扩展 ID 为 `lpmplddblefacpachnchfgcdebjebdbh`。仍应对照扩展管理页实际显示的 ID；自行更改构建 key 后必须使用自己的 ID。

此时可以在普通网页选中文字，用右键或 `Alt+Shift+S` 保存。扩展即使尚未连接 MCP，也应能够保存和查看记录。

更新源码或替换扩展构建后，在扩展管理页点击该扩展的“重新加载”，再重开侧栏。仅重新打开浏览器窗口不能作为新代码已加载的检查；不要为更新删除扩展数据。

## 3. 安装本地桥并生成客户端配置

将下方 `YOUR_PROFILE_ID` 替换为上一步的连接标识。安装器生成 Native Messaging 注册文件、启动脚本和 MCP 配置示例。它默认保护已经存在的文件；遇到 `INSTALL_TARGET_EXISTS` 时，先确认已有文件是否属于当前安装，更新自己的旧安装才使用 `--overwrite`。

macOS / Google Chrome：

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

使用 Chromium 时，将 `--manifest-dir` 改为 `$HOME/Library/Application Support/Chromium/NativeMessagingHosts`；使用 Edge 时改为 `$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts`。这些浏览器分别读取自己的注册目录。

Linux 的对应目录通常为 `$HOME/.config/google-chrome/NativeMessagingHosts`、`$HOME/.config/chromium/NativeMessagingHosts` 或 `$HOME/.config/microsoft-edge/NativeMessagingHosts`。不同分发渠道可能有自己的目录；该平台尚需按兼容矩阵完成实机验证。

Windows 可以使用同一 CLI 生成文件，再把当前用户注册表中对应浏览器的 Native Messaging 主机默认值设置为生成的 JSON 文件绝对路径。CLI 输出的 `manualBrowserLocations` 列出对应注册表键。Windows 的主机启动与注册尚未在本项目实机验证，不将仅生成文件算作支持通过。

安装成功时，终端返回 JSON，包含 `nativeHost.manifestPath`、`nativeHost.launcherPath` 和 `mcpConfig.path`。不要移动或删除组件安装目录；生成的配置使用绝对路径。

将 `babel-clipper-mcp.json` 中 `mcpServers` 下的条目合并到客户端自己的 MCP 配置中。不同客户端的配置文件位置和外层格式不同，应使用该客户端提供的 MCP 设置入口。生成的 `command` 是本机 Node 绝对路径，参数包含组件、配置目录和 `profileId`；不需要填写作者电脑上的路径。

输出目录只需选择一种入口：

- 素材库“连接与设置”中的“全局默认成品目录（可选）”。
- 安装时添加 `--output-root /absolute/path/to/output`，保存一个 MCP 默认目录；也可在某个客户端的 MCP 启动参数里添加 `--output-root`，仅覆盖该连接的默认目录。
- 处理某次任务时由用户或 Agent 明确提供的绝对目录。

解析顺序为本次任务、MCP 默认、扩展全局；单次覆盖不修改默认值。显式提供但不可用的目录会报错，不改存到别处。

例如，某个客户端可以采用独立的连接默认目录：

```sh
node dist/node/cli.js --mode=mcp --profile-id YOUR_PROFILE_ID --output-root /absolute/path/to/client-output
```

这是 stdio 服务启动命令，通常由 MCP 客户端运行。它不会修改扩展的全局设置或其他客户端的配置。

## 4. 检查完整连接

安装完成后，在素材库“连接与设置”点击“重连本地服务”，并启动或刷新客户端的 MCP 连接。随后运行：

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

如果安装时使用了 `--config-dir`，诊断时使用同一个参数。`ready: true` 和扩展诊断成功才表示所选 profile 的完整连接已就绪。缺少浏览器连接、配置错误和主机未启动会分别返回具体状态。

让 Agent 执行“查询 Babel Clipper 的待处理记录”。只查询不会领取或处理任务。确认它能读取刚才的选文后，再明确要求“把这一条选文保存为文本文件，并回写处理结果”；Agent 按 [执行契约](agent-workflow.md) 领取该 Job，保存产物并提交结果。素材库应显示已处理及该次历史。

## 常见故障

| 现象 | 排查方向 |
|---|---|
| `PROFILE_REQUIRED` 或 profile 不一致 | 从当前浏览器素材库复制 `profileId`，检查客户端参数，不能使用其他测试 profile。 |
| Native Host 找不到 | 检查注册目录是否属于当前浏览器、JSON 中的扩展 ID、启动脚本路径与执行权限；再点击重连。 |
| `BROKER_UNAVAILABLE` | 启动扩展的本地连接或 MCP 客户端；doctor 只检查，不负责后台启动。 |
| `BROWSER_UNAVAILABLE` | 保持对应浏览器和扩展运行；检查素材库的本地服务连接状态。此错误不表示待办为空。 |
| `WRITEBACK_UNACKNOWLEDGED` 或回写时断线 | 保留原 `requestId` 和原结果内容，重连后幂等重发；未获持久化 ACK 前不要宣称完成。 |
| 已处于处理中但 Agent 失联 | 先核实原执行是否仍在运行；系统不会因超时自动释放或重复执行。 |
| 网页无法采集 | 浏览器内部页、权限受限页或特殊阅读器可能无法访问；使用明确标注的降级方式，截图不会变成原文。 |
| `TAB_CAPTURE_PERMISSION_REQUIRED` | 切回要录制的网页，点击浏览器工具栏上的 Babel 扩展图标，再为本次片段开启现场保存。也可先在该页选文并用真实快捷键采集，再直接从侧栏录制；本次验收通过了该路径。授权调用必须发生在目标网页，不能在素材库页调用后当作视频页已授权。扩展重载后需重新调用；具体脱敏原因会保存在失败详情中，未启动时只能算已记录时间范围。 |
| 输出目录错误 | 检查实际最高优先级的目录及当前系统用户权限，不要求在两处重复配置。 |

卸载扩展或删除浏览器数据会影响本地资料。移动到新 profile 前先导出备份，并确认导出是否包含附件字节；只有元数据的备份不能恢复图片或录制文件。外部 Agent 成品不包含在扩展附件备份中。
