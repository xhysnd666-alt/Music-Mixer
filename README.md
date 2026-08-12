# 音乐融合工坊

本地运行的 AI 音乐混音工具，面向 vlog 创作者：

- 六轨分离：人声、鼓、贝斯、吉他、钢琴、其他
- 无缝拼接：两首歌按节拍对齐自然衔接，听不出接缝
- 智能融合：一键混合两首歌，或自定义要素分配（A 人声 + B 伴奏 / A 为主 B 为辅）
- 一键自动 + 高级手动面板

## 快速开始

1. 双击 `启动工具.bat`
2. 浏览器自动打开 `http://localhost:8000`
3. 导入两首歌，选择模式，点击「开始处理」

## 模式说明

### 无缝拼接

- A 的前段 + B 的后段，切点可手动调整
- 自动做节拍对齐（轻微变速、保持音高）和调性对齐（轻微移调）
- 交叉淡化让过渡自然，统一响度后导出

### 智能融合

- **A 人声 + B 伴奏**：AI 分离两首歌后重组（最耗时，约 2-6 分钟）
- **A 为主 · B 为辅**：以 A 为骨架，融入 B 的鼓点或整曲
- **均衡混合**：两首等量混合

## 技术栈

- 后端：FastAPI + Demucs 4.1 (htdemucs_6s) + librosa + ffmpeg（imageio-ffmpeg 自带）
- 前端：原生 HTML/CSS/JS，深色毛玻璃风格
- 分离模型运行在本机 GPU（NVIDIA 3060 实测：24 秒音频约 10 秒完成）

## 模型来源

六轨分离权重（htdemucs_6s，55MB）来自 ModelScope 的
[pengzhendong/uvr-demucs](https://modelscope.cn/models/pengzhendong/uvr-demucs)
镜像仓库，已下载到 `data/models/demucs_6s/`，离线可用，无需再联网。

## 目录结构

```
music-mixer/
├─ 启动工具.bat      # 双击启动
├─ backend/          # FastAPI + 音频引擎
├─ frontend/         # 网页界面
├─ data/
│  ├─ uploads/       # 上传的歌曲
│  ├─ results/       # 导出成品
│  └─ models/        # AI 分离模型
└─ .venv/            # Python 虚拟环境
```

## 版权提醒

工具仅用于个人学习与创作。从平台下载的音乐用于二创时，请注意平台版权规则；
分离出的素材请勿公开传播。
