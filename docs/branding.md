# 项目标识

Babel Content Clipper 的标识以字母 **B** 为主体，右上角分离的琥珀色切角代表从网页中留下的内容片段。墨色底与暖白字形沿用素材库的视觉风格，小尺寸也保留相同轮廓。

<img src="assets/logo.png" alt="Babel Content Clipper Logo" width="192" height="192">

## 资产

| 文件 | 用途 |
| --- | --- |
| [logo.svg](assets/logo.svg) | 矢量源文件，128 × 128 画布，可无损缩放 |
| [logo.png](assets/logo.png) | 1024 × 1024 PNG，用于仓库头像、README 和项目介绍 |
| `apps/extension/public/icons/icon-{16,32,48,128}.png` | 工具栏、扩展管理页和页面 favicon |

图形由矢量路径组成，不依赖字体、外部图片或网络请求。PNG 的圆角外部为透明背景。

## 颜色与用法

| 颜色 | 值 | 用途 |
| --- | --- | --- |
| 墨色 | `#2D261E` | 底形 |
| 暖白 | `#FFF8E8` | 字母主体 |
| 琥珀色 | `#E8AA4F` | 裁切角 |

保持正方形比例和完整底形，四周至少留出标识宽度的 1/8 空间。工具栏使用对应尺寸的 PNG；网页正文优先使用 SVG。标识图片旁已有项目名或页面标题时，将装饰性图片的 `alt` 设为空，避免重复朗读。

修改标识时，以 `logo.svg` 为源，同步导出 16、32、48、128 和 1024 像素 PNG。执行 `npm run build` 会把 SVG 复制进扩展，执行 `npm run verify:package` 会核对界面、favicon 和 manifest 引用的图标文件。

使用范围见 [许可政策](../LICENSE-POLICY.md)。
