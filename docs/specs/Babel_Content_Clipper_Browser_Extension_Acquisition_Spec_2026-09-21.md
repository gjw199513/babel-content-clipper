# Babel Content Clipper：扩展侧源媒体获取规范

> 独立功能 Spec，不并入既有总体 PRD，也不覆盖待办批处理 Spec。
> 创建时间：2026-09-21 CST
> 状态：IMPLEMENTED；静态、协议和单元验证记录见本文末尾。

## 目标

当 Capture 只有媒体位置、已有文字不足且本次 Job 确实需要视频文字时，由已连接的 Babel Content Clipper 浏览器扩展获取源媒体并保存为扩展附件。Agent 随后通过 MCP 导出附件到受控本地目录，再使用自己的 FFmpeg、sherpa-onnx、模型和 LLM 完成后处理。

这项能力解决的是“谁负责浏览器侧取源”，不是把 Clipper 变成 ASR 运行器，也不是让 Agent 通过浏览器 UI 自动点击下载。

## 明确禁止的路径

- 不使用 Codex CUA、Playwright、Puppeteer 或其他浏览器 UI 自动化作为生产取源路径。
- 不打开来源页、不点击下载按钮、不导航页面、不控制播放器来完成下载。
- 不把带 token 的 `pageUrl`/`mediaUrl`、Cookie 或 claim token 交给 Agent 自己的 HTTP 客户端、yt-dlp 或平台下载器。
- MCP 不直接下载媒体、不安装依赖、不运行 FFmpeg、sherpa-onnx 或 LLM；它只校验有效 claim、转交扩展请求、交付附件和回写状态。

## 职责边界

| 组件 | 必须负责 | 明确不负责 |
|---|---|---|
| Babel 浏览器扩展 | 在有效 claim 下读取私有媒体上下文；后台请求源媒体；必要时在原始页面上下文取 `blob:`/登录态媒体；分块写入扩展 IndexedDB 附件 | ASR、模型下载、LLM 校正、跨 Job 合并 |
| Clipper MCP | 暴露 `babel_clipper_acquire_source_media`；把请求经过 Native Messaging/broker 路由到扩展；暴露 `babel_clipper_export_capture` 导出本地文件 | 自己发起 HTTP 下载；浏览器页面自动化；后处理执行 |
| 当前 Agent | 判断是否需要文字；领取 Job；调用扩展取源；导出并验证本地媒体；执行 FFmpeg、ASR、校正和结果回写 | 直接访问私有来源 URL；使用浏览器自动化或另起下载器取源 |

## 调用契约

### MCP 工具

工具名：`babel_clipper_acquire_source_media`

输入：

```json
{
  "requestId": "unique-request-id",
  "captureId": "cap_...",
  "jobId": "job_...",
  "claimToken": "..."
}
```

调用前必须已经领取 Job，且只能使用 `claim_records` 返回的 `claimToken`。扩展内部重新校验 Capture/Job 对应关系、`processing` 状态和 claim 所有权。

成功返回只包含扩展附件结果：

```json
{
  "captureId": "cap_...",
  "jobId": "job_...",
  "attachmentId": "asset_...",
  "mimeType": "video/mp4",
  "byteLength": 123456,
  "acquisition": "extension_background_fetch",
  "browserPlugin": "babel_content_clipper"
}
```

`acquisition` 可能是 `extension_background_fetch` 或 `extension_page_fetch`。第二种只表示扩展在原始页面上下文完成了取流，不表示使用了页面点击或 UI 自动化。

成功后必须再次调用 `babel_clipper_export_capture`。只有导出目录中实际存在、可读取且通过大小/哈希检查的文件，才可以进入 FFmpeg 或 ASR。

### 扩展侧 NativeMethod

MCP broker 将 `capture.acquireMedia` 转发到当前 profile 的扩展 Native Messaging 连接。这个方法不是公开 Core 数据库方法；扩展后台收到后执行：

1. 在扩展内部调用 `capture.getAcquisitionSource` 校验 claim 并读取私有上下文。
2. 读取 Capture 的媒体类型和原始 frame 信息。
3. 优先用扩展 service worker 的 `fetch(..., credentials: include)` 获取 HTTP(S) 媒体。
4. 后台取源失败，或地址是 `blob:`/需要页面登录态时，定位保存该 Capture 的标签页，通过扩展 content script 在页面上下文 `fetch`。
5. 用有界分块写入 `attachment.create`、`attachment.appendChunk`、`attachment.complete`。任何中断都保留已落库分块并标记附件 `interrupted`。

## URL 与隐私

- Capture 公共记录只保存脱敏后的页面/媒体信息。
- 扩展私有 source context 可以短期保存采集时的原始 HTTP(S) 地址和 `blob:` 地址，仅在有效 claim 且只经过扩展内部使用。
- `blob:` 地址只能在原始标签页的对应文档上下文使用；找不到对应标签页时必须返回明确失败。
- 私有地址、Cookie 和 claim token 不进入 Agent 工具响应、导出 manifest、日志、ASR 上下文、LLM 输入或终态 Result。
- 失败消息只能返回脱敏 URL 或状态码，不回显完整 token-bearing URL。

## Agent 执行顺序

1. `babel_clipper_get_record` 读取真实 Capture/Job、输出要求、范围和已有附件。
2. 只有明确需要文字且已有文字不足时，读取 `video_text_extraction` 指南。
3. `babel_clipper_claim_records` 原子领取，保存对应 claim token。
4. `babel_clipper_export_capture` 导出已有内容。
5. 媒体缺失时调用 `babel_clipper_acquire_source_media`。
6. 再次 `babel_clipper_export_capture`，取得本地源媒体。
7. Agent 用 ffprobe/FFmpeg 检查并抽取音频，按指南下载/校验 sherpa-onnx 模型，执行 ASR、上下文校正、文件验证和结果回写。

如果扩展未连接、原始标签页已关闭、权限不足、源媒体失效或附件预算不足，Agent 必须按真实阶段回写失败；不得改用浏览器点击或另起下载器掩盖失败。

## OpenCLI 参考边界

参考实现：`/Users/guojingwei/develop/ai-project/dsh-content-workbench/vendor/opencli/extension/`。

借鉴内容：

- 扩展作为浏览器侧桥接端，使用受控协议把浏览器上下文能力提供给本地 Agent/daemon；
- service worker 与本地进程之间使用明确请求 ID、profile/session 路由和有界响应；
- 对动态媒体保留网络/页面上下文获取的后备通道。

不照搬内容：

- OpenCLI 的 `navigate`、`exec`、`cdp`、页面点击和通用浏览器自动化不属于 Clipper 生产取源接口；
- Clipper 只增加面向已领取 Capture/Job 的窄化 `capture.acquireMedia`，不提供任意网页执行能力；
- 扩展只持久化本地附件和业务事实，不把 Cookie 或私有 URL 作为 Agent 侧长期数据。

## 验收标准

- 带签名参数的媒体地址：公共 Capture 脱敏，扩展仍可用原始地址取流，Agent 响应不出现 token。
- `blob:` 媒体地址：扩展能定位原始标签页并在页面上下文分块取流；关闭标签页后返回明确失败。
- 直接后台取流失败时，不打开或点击任何页面控件，自动进入扩展页面上下文后备路径。
- 分块顺序、最大分块大小、附件总字节数和终态状态均经 Core 校验；中断保留部分事实。
- 没有有效 claim、Job 已终态、profile 未连接或 Capture/Job 不匹配时拒绝取源。
- Agent 只能从 `babel_clipper_export_capture` 得到本地文件，不能从工具响应得到私有源 URL。
- 已有文字足够或 Job 不要求文字时，不调用取源工具，不下载媒体、不下载模型、不运行 ASR。

## 实现验证

- `npm run typecheck`：通过。
- `npm test`：覆盖 source context 脱敏、NativeMethod 白名单、MCP 工具注册/拒绝无效结果、源流消息分类，以及 Core 附件的顺序分块、幂等和中断保留；真实页面上下文取流仍需在目标浏览器/站点上单独验收。
- `npm run build`：扩展与 Node MCP 产物均能构建。
- 浏览器平台验证只验证扩展自身行为，不把 CUA/Playwright 的页面点击结果当作生产取源证据。
