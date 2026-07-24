# CLAUDE.md — Kashgar Urban Digital Twin Showcase

> 这是一个项目展示仓库，不含源代码。它的目的是向潜在雇主展示技术能力和项目经验。

## 仓库定位

- **角色**：public GitHub 项目展示页
- **受众**：招聘方、技术面试官、同行开发者
- **原则**：架构图 + 关键数字 + 精选代码片段 + 截图，不放完整源码
- **上游**：实际项目代码在私有仓库 `cesium-mvp`，不在本仓库中

## 目录结构

```
kashgar-urban-digital-twin/
├── README.md
├── CLAUDE.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PERFORMANCE.md
│   └── COLLABORATION.md
├── screenshots/
│   ├── 01-3d-city-overview.png
│   ├── 02-building-click-info.png
│   ├── 03-thematic-map.png
│   ├── 04-mobile-web.png
│   └── 05-architecture-diagram.png
└── snippets/
    ├── collision-resolution.js
    ├── drillpick-passthrough.js
    └── height-offset.js
```

## README.md 写作要求

- 英文撰写（GitHub 上展示，招聘方可能来自国内外）
- 第一屏必须包含：一句话描述 + 关键数字（25K 栋、48% 优化）+ 截图
- 采用"What I Built Beyond Just Code"四层结构：数据/平台/安全/客户
- 底部标注源码未公开原因

## 代码片段规则

- 每个 snippet 20-50 行，必须有英文注释解释上下文和动机
- 只展示能证明技术深度的部分，不是完整可运行代码
- 脱敏：不包含真实坐标、服务器地址、API 路由

## 截图规则

- 从 cesium-mvp 实际运行中截取
- 打码或模糊处理：楼栋地址字段、用户名、任何可识别个人身份的信息
- 优先展示：3D 全景、交互效果、专题渲染、移动端界面

## 禁止事项

- 不放源代码（除了精选片段）
- 不放真实 GeoJSON 数据
- 不放配置文件（包含 API 密钥、服务器信息）
- 不放内部汇报材料
- 不暴露 cesium-mvp 私有仓库的路径和结构

---

> 创建日期：2026-07-24
> 上游私有仓库：cesium-mvp
