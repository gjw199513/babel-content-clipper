# 第三方组件

下列信息从本次锁定安装的 package.json 与包内许可文件读取。项目自身的个人非商业使用方向不改变第三方组件的许可条件。具体依赖版本以 package-lock.json 为准。

| 组件 | 锁定版本 | 包声明许可 | 用途 |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | MIT | 标准 MCP stdio 服务与测试客户端 |
| DOMPurify | 3.4.15 | MPL-2.0 OR Apache-2.0 | 选中 HTML 的安全清理 |
| idb | 8.0.3 | ISC | IndexedDB 事务接口 |
| Zod | 4.6.5 | MIT | 业务参数校验 |

构建和测试工具包括 TypeScript、typescript-language-server、esbuild、Vitest、Playwright、fake-indexeddb 与 fflate。FFmpeg/ffprobe 用于本机验证和可选外部媒体处理，不打包进扩展，也不作为所有采集操作的前置条件。

构建保留依赖的法律注释，扩展发行包内附上打包组件的许可原文。MCP npm 包的依赖由 npm 按 package-lock/依赖声明安装，依赖包自身的许可文件继续随其分发。公开发布前须按最终构建、变更和分发方式核对完整声明，不以本表替代最终许可审核。
