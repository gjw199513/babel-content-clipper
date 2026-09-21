# 本地采集测试素材

所有页面仅为本项目的测试夹具；页面正文与示意 SVG 为本项目编写。`media/sample.webm` 来自 FFmpeg 的 testsrc2 与 sine 测试信号，不含第三方节目。

生成命令：

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 30 \
  -c:v libvpx-vp9 -crf 44 -b:v 0 -c:a libopus -b:a 32k media/sample.webm
```

实测文件时长 30.008 秒，包含 VP9 视频轨与 Opus 音频轨。该文件可用于播放器时间、跳转、裁切、现场录制及实际音轨检查；不能据此宣称公开视频平台兼容性通过。

根目录执行 `npm run fixtures`，访问终端显示的本机地址。`article.html` 测试选文/图文/图片/输入框，`reader.html` 测试原阅读器菜单和换章，`media.html` 测试视频与音频元素，`frames.html` 测试 iframe。
