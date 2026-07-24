# Kashgar Urban Digital Twin Platform

> **Solo-built 3D urban digital twin for 25,000+ buildings. 4 months. Zero prior web dev experience.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status: Production](https://img.shields.io/badge/status-production-green)
![Stack: Vue3%2BCesium%2BNode](https://img.shields.io/badge/stack-Vue3%2BCesium%2BNode-orange)

---

## What It Does

A 3D WebGIS platform used by a Chinese city government for urban renewal management. It combines UAV tilt photography (3D Tiles), interactive building vector data (GeoJSON), and multi-department collaborative editing into a single web interface — both desktop and mobile.

![Screenshot placeholder — 3D city overview](screenshots/01-3d-city-overview.png)

**Key numbers**:
- **25,000+ buildings** managed with 66 attribute fields each
- Loading time reduced from **8.5s → 4.4s** (48% optimization)
- **5 departments** collaborating simultaneously
- **100% solo developed** (~15,000 lines of code)
- **1,000+ CAD drawings** auto-extracted (100x efficiency gain)

---

## What I Built (Beyond Just Code)

This wasn't just a coding project. I handled the full chain from data to delivery:

### Data Layer
- Coordinated **4+ utility companies** (gas, heating, water, power) + **30+ community offices** to source multi-format data
- Built **CAD auto-extraction plugins** for pipeline/utility drawings — processing time from 15 min/sheet to 5 seconds
- Led **field surveys** verifying 25,000+ buildings on foot with community workers

### Platform Layer
- **Solo full-stack**: Vue3 + Cesium.js (3D GIS) + Node.js/Express
- **3D Tiles UAV model** (3.1GB / 11,000+ B3DM tiles) + **25K extruded GeoJSON buildings** with thematic rendering
- **Multi-user collaborative editing**: feature-level locking + 3-tier versioning + automatic conflict resolution
- **Mobile web app**: GPS tracking, compass, custom touch gestures, no app install required
- **Performance optimization**: 48% loading time reduction through systematic profiling (JS + GPU dual optimization)

### Security & Compliance
- Led **cloud deployment security audit** (11 technical reports covering network grading, geospatial data regulations, data classification)
- Designed **2-layer brute-force protection** (IP rate limiting + account lockout after 5 failed attempts)
- Implemented JWT 3-role auth + token versioning (anti-concurrent-login)

### Client & Delivery
- Sat in **municipal committee meetings** to get requirements directly from decision-makers — avoiding 4-layer information distortion through bureaucracy
- Translated government policy documents into technical implementation plans
- Wrote project proposals and progress reports for government stakeholders

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend                          │
│  Vue3 SPA  ───  Cesium.js 3D Engine                 │
│  Desktop UI  +  Mobile Web (scan QR to use)         │
├─────────────────────────────────────────────────────┤
│                    Backend                           │
│  Express API  ───  JWT Auth  ───  GeoJSON Store     │
│  Feature Locks  +  Version Tracking  +  Mutex       │
├─────────────────────────────────────────────────────┤
│                 Data Sources                         │
│  UAV Photos  │  CAD Drawings  │  Field Surveys      │
│  Utility DBs │  Government Reports                   │
└─────────────────────────────────────────────────────┘
```

---

## Project Structure

```
kashgar-urban-digital-twin/
├── README.md                   ← You are here
├── CLAUDE.md                   ← AI assistant context
├── docs/
│   ├── ARCHITECTURE.md         ← Technical architecture deep dive
│   ├── PERFORMANCE.md          ← 8.5s→4.4s optimization case study
│   └── COLLABORATION.md        ← Multi-user editing system design
├── screenshots/                ← Platform screenshots
└── snippets/                   ← Curated code samples (20-50 lines each)
    ├── collision-resolution.js
    ├── drillpick-passthrough.js
    └── height-offset.js
```

---

## Tech Stack

| Layer | Technology |
|:------|:-----------|
| 3D Engine | Cesium.js (3D Tiles / B3DM) |
| Frontend | Vue3, JavaScript/ES6 |
| Backend | Node.js, Express |
| Data | GeoJSON, 3D Tiles |
| Auth | JWT + bcrypt |
| Deployment | Docker, Linux, Nginx, SSL |
| AI Tools | Claude Code (AI-assisted development) |

---

## 📁 Source Code

The full source code is not publicly available due to:
- Government geospatial data involved in the project
- Client confidentiality requirements

The architecture documents, performance case studies, and code snippets in this repository represent my original work on the project. They are sufficient to demonstrate technical depth and engineering capability.

---

> **Built by [QinJiojio](https://github.com/QinJiojio)** · 2026
> **Live platform**: `www.cuc-kashi.top` (accessible in China)
