# AQ 的工作台（workbench）

AQ 的个人工作台 —— 一个运行在浏览器里的私人工作面板，随时记录、安排和回看每天要做的事。

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 📋 待办事项 | 添加 / 勾选完成 / **双击修改** / **长按拖拽排序** / 月度自动归档（完成的任务次日自动收进「本月已完成」） |
| 🔁 每日习惯 | 长期习惯打卡，最近 7 天 / 30 天统计 |
| ⏱ 番茄钟 | 专注计时 |
| 📅 日历 | 月 / 周 / 日视图，本地事件 + ICS 日历订阅，**大小周排班**（自动交替），「✅ 已完成」回看每天完成的任务 |
| 🗒 便签 | 随手记事 |
| 📁 文件暂存 | 上传、下载、分享链接（带过期时间） |
| 🔔 通知中心 | 日历提醒、系统消息 |
| 🎨 外观 | 深 / 浅双主题 + 6 套主题色，PWA 可安装到手机 / 电脑桌面，离线可用 |
| ⚙️ 设置 | 数据保留期（待办 / 打卡 / 通知独立设置）、存储占用统计 |

## 🧱 技术栈

- 后端：Python 3 + Flask + SQLite（单文件数据库，无需额外配置）
- 前端：原生 HTML / CSS / JS（无框架）
- PWA：Service Worker 离线缓存

## 🚀 本地运行

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 启动（数据库文件 data.db 会自动创建）
python app.py

# 3. 浏览器打开
# http://localhost:5000
```

## 🖥 部署到 VPS（Linux）

以 Ubuntu + systemd 为例：

```bash
# 1. 上传代码到服务器（示例目录 /opt/workbench）
scp -r ./* root@你的VPS:/opt/workbench/

# 2. 在服务器上安装环境
cd /opt/workbench
apt install -y python3-venv
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# 3. 安装 systemd 服务（workbench.service 已在仓库里，按需改路径）
cp workbench.service /etc/systemd/system/workbench.service
systemctl daemon-reload
systemctl enable --now workbench

# 4. 用 Caddy / Nginx 反代 + 绑定域名
# 参考仓库里的 Caddyfile.vps
```

> ⚠️ 数据库 `data.db` 和 `uploads/` 目录**不会**上传到 Git（已在 .gitignore 里排除），
> 换设备部署时它们会自动重新创建，个人数据请自行备份迁移。

## 📝 说明

- 这个仓库是私有的个人项目。
- 部署配置参考：`Caddyfile.vps`（Caddy 反代）、`workbench.service`（systemd 服务）。
