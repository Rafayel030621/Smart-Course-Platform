# V3/V4 后端生产部署：SQLite、原生依赖与数据库备份

> 适用范围：`server/` 的 V2 + V3/V4 后端。
> 本文只描述部署要求，不包含任何生产操作、密钥、Nginx/Cloudflare/18080 配置变更。

## 1. 关键结论

1. `better-sqlite3` 是**原生 C++ 扩展**，不能把 Windows 的 `node_modules` 直接复制到 Linux 服务器。
2. 不能只上传 `server/dist`：V2/V3 运行时依赖 `bcryptjs`、`better-sqlite3` 及其原生二进制。
3. 推荐在**与生产服务器同架构、同 libc** 的 Linux 环境安装/构建，再打包 `dist + package.json + package-lock.json + node_modules`；或在服务器上安装生产依赖。
4. SQLite 数据库默认位于进程工作目录的 `data/course-platform.sqlite`，生产必须用 `SCP_DB_PATH` 指向专用目录，并确保目录和文件权限只对服务账号可读写。
5. 数据库迁移在**首次访问 V3 路由**时自动执行，不在进程启动时执行。服务可以先启动成功，但第一条 V3 请求才会建库/迁移。

## 2. Node 与原生依赖

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 20.19`；建议生产固定 LTS（20.x 或 22.x），与构建机一致 |
| better-sqlite3 | 12.x；Node ABI 必须与安装时的 Node 一致，升级 Node 后要重装依赖 |
| 构建机 | Linux x64/arm64，与服务器 CPU 架构一致 |
| libc | 不要在 Alpine（musl）构建后复制到 Debian/Ubuntu（glibc），反之亦然 |
| 编译工具（无预编译包时） | `python3`、`make`、`g++`（或 `build-essential`） |

### 2.1 推荐部署方式

在 CI 或服务器上：

```bash
cd server
npm ci                 # 构建需要 typescript 等 devDependencies
npm run build
npm ci --omit=dev      # 只保留运行时依赖（含 better-sqlite3 原生模块）
```

需要随发布物保留：

```text
server/dist/
server/package.json
server/package-lock.json
server/node_modules/       # 与目标 Linux/Node 匹配的生产依赖
```

仅上传 `dist` 会在启动或首次 V3 请求时报 `Cannot find package 'better-sqlite3'` / `bcryptjs`。

### 2.2 服务器上不要做的事

- 不要复制 Windows 的 `server/node_modules`；
- 不要在服务器上用不同 Node 版本复用旧 `node_modules`；
- 不要把 `node_modules` 提交到 git；
- 不要在 18080 端口、现有隧道或 Nginx 上做任何改动。

## 3. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SCP_DB_PATH` | 生产必填 | SQLite 文件绝对路径，如 `/var/lib/course-platform/course-platform.sqlite` |
| `SCP_COOKIE_SECURE` | 否 | 默认 `1`；仅本地 http 开发可设 `0`，生产不要关闭 |
| `INVITE_CODE_SHA256` | 注册必填 | 邀请码 SHA-256 十六进制，逗号分隔；不要放明文 |
| `BCRYPT_ROUNDS` | 否 | 默认 12；生产不建议低于 12 |
| `SCP_TRUST_PROXY_HOPS` | 否 | 默认 `0`（不信任 XFF）；只有前面有 N 层可信反代时才设置 |
| `HOST` / `PORT` | 是 | 沿用现有部署，不要改 18080 |

`SCP_DB_PATH` 的父目录必须存在且服务账号可写；不要放在静态站点目录、仓库目录或 NFS 上。

## 4. 数据库、权限与迁移

### 4.1 目录与权限

```bash
# 示例：具体用户/路径按现网调整
sudo install -d -m 700 -o <service-user> -g <service-group> /var/lib/course-platform
# 数据库文件由服务创建；如手工创建：
sudo install -m 600 -o <service-user> -g <service-group> /dev/null /var/lib/course-platform/course-platform.sqlite
```

- 目录 `700`，数据库文件 `600`；
- 不要让 Web 静态目录、备份目录与数据库目录混用；
- WAL 模式会生成 `*.sqlite-wal`、`*.sqlite-shm`，同目录、同权限。

### 4.2 自动迁移的触发时机

- `createApp()` 不会立即建库；
- 首次访问 `/api/auth/*` 或 `/api/projects*` 时，`V3Runtime.getDb()` 打开数据库并执行 `schema_migrations` 中未应用的迁移；
- 迁移是**前向、幂等**的；当前没有 down migration；
- 迁移失败时请求返回 500，数据库保留在已回滚的迁移事务状态；
- 升级发布前应先用数据库副本在预发环境启动一次并访问 V3 路由，确认迁移成功。

建议发布后做一次最小验证（不写业务数据）：

```bash
curl -i http://127.0.0.1:<PORT>/health
curl -i http://127.0.0.1:<PORT>/api/auth/me   # 未登录应为 401 UNAUTHORIZED
```

### 4.3 启动与 systemd 示例

```ini
[Service]
User=<service-user>
Group=<service-group>
WorkingDirectory=/opt/course-platform/server
EnvironmentFile=/etc/course-platform/backend.env
ExecStart=/usr/bin/node /opt/course-platform/server/dist/src/index.js
Restart=on-failure
```

`WorkingDirectory` 必须与相对路径 `SCP_DB_PATH` 的预期一致；生产建议直接用绝对路径。

## 5. 备份、恢复与回滚

### 5.1 安全备份

SQLite 使用 WAL 时，**不能在服务运行时只复制 `.sqlite` 单文件**，否则可能漏掉 WAL 中的已提交事务。推荐任一方式：

1. 停服务后复制 `*.sqlite`、`*.sqlite-wal`、`*.sqlite-shm`（三者一起）；
2. 服务运行时使用 SQLite 在线备份：

```bash
sqlite3 /var/lib/course-platform/course-platform.sqlite \
  ".backup '/var/backups/course-platform/course-platform-$(date +%F-%H%M).sqlite'"
```

或：

```bash
sqlite3 /var/lib/course-platform/course-platform.sqlite \
  "VACUUM INTO '/var/backups/course-platform/course-platform-$(date +%F-%H%M).sqlite'"
```

备份文件权限同样收紧为 `600`，并定期验证可恢复性。不要把备份提交到 git 或放进前端 `dist`。

### 5.2 恢复

1. 停止服务；
2. 将当前数据库、WAL、SHM 移到隔离目录（不要直接覆盖，便于回滚）；
3. 恢复备份的 `.sqlite`；
4. 确认属主/权限；
5. 启动服务并访问一次 V3 路由验证迁移状态；
6. 核对关键计数（用户、项目、阶段、任务）后再开放流量。

### 5.3 应用回滚

- 迁移只有前向版本，没有自动降级；
- 回滚应用版本时，必须同时恢复到**该版本对应的数据库备份**；
- 不要让旧版本代码直接连接已经被新迁移修改过的数据库；
- 回滚前先做一次当前库备份，避免二次损坏。

## 6. 并发与运行边界

- 当前按**单实例**设计：一个进程写一个 SQLite 文件；
- WAL 允许多读单写，但不要让多个应用实例共享同一个数据库文件来扩容；
- 不要把数据库放到 NFS/SMB/网络盘；
- 需要多实例时，后续应迁移到 PostgreSQL/MySQL，而不是在 SQLite 上叠加多写。

## 7. 安全检查清单

- [ ] `SCP_DB_PATH` 在专用目录，权限 `700/600`
- [ ] `SCP_COOKIE_SECURE` 未关闭
- [ ] 邀请码只配置 `INVITE_CODE_SHA256`，没有明文
- [ ] 没有复制 Windows `node_modules`
- [ ] Node 版本与原生模块 ABI 一致
- [ ] 已做数据库备份并验证恢复
- [ ] 未修改 Nginx、Cloudflare 隧道、18080 或模型密钥
- [ ] 首次 V3 请求后检查迁移日志，无 SQL/路径/正文进入日志

## 8. 本次生产上线记录（2026-10-24，w-4090@sinnet）

> 目标环境：`https://course.xinxian-music.xyz`（前端静态目录 `/home/w-4090/wzh-jhl/frontend`）
> + `https://api.xinxian-music.xyz`（Cloudflare 隧道 → `127.0.0.1:8080`，systemd 单元
> `course-wzh-jhl-backend.service`，Node v22.22.3 via nvm）。

### 8.1 上线步骤（按序）

```bash
# 1) 环境准备（只追加，不动其他变量）
sudo install -d -m 700 -o w-4090 -g w-4090 /var/lib/course-platform
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('<邀请码>').digest('hex'))")
sudo tee -a /etc/course-platform/backend.env >/dev/null <<CFG
SCP_DB_PATH=/var/lib/course-platform/course-platform.sqlite
INVITE_CODE_SHA256=$HASH
CFG

# 2) 依赖（服务器原本没有 server/node_modules；better-sqlite3 预编译下载超时，改源码编译）
scp server/package.json server/package-lock.json w-4090@<host>:/home/w-4090/wzh-jhl/backend/
mkdir -p /home/w-4090/.deploy-cache/node-gyp
cd /home/w-4090/wzh-jhl/backend
XDG_CACHE_HOME=/home/w-4090/.deploy-cache \
npm_config_cache=/home/w-4090/.npm-deploy-cache \
npm_config_devdir=/home/w-4090/.deploy-cache/node-gyp \
NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node \
  /home/w-4090/.nvm/versions/node/v22.22.3/bin/npm ci --omit=dev --build-from-source
node -e "import('better-sqlite3').then(()=>console.log('native ok'))"

# 3) 本地构建前端（必须带 API 地址，否则默认指向 127.0.0.1:8080）
$env:VITE_API_BASE_URL="https://api.xinxian-music.xyz"; npm run build; Remove-Item Env:VITE_API_BASE_URL

# 4) 上传：先传 dist.new，验货，再切换
scp -r server/dist  w-4090@<host>:/home/w-4090/wzh-jhl/backend/dist.new
scp -r dist\.       w-4090@<host>:/home/w-4090/wzh-jhl/frontend/

# 5) 切换（关键：先验货，失败要能中止）
cd /home/w-4090/wzh-jhl/backend
ls -l dist.new/src/index.js                      # 缺文件就不要继续
test -d dist.new && mv dist dist.old-$(date +%F-%H%M) && mv dist.new dist && echo 切换完成

# 6) 重启与迁移验证
sudo systemctl restart course-wzh-jhl-backend.service
curl -sS  http://127.0.0.1:8080/health                     # 200 {"status":"ok"}
curl -isS  http://127.0.0.1:8080/api/auth/me | head -3     # 401 = 迁移成功
sudo ls -lh /var/lib/course-platform/                      # 出现 .sqlite / -wal / -shm
sudo chmod 600 /var/lib/course-platform/course-platform.sqlite*
```

### 8.2 本次踩到的三个坑

1. **服务器原本没有 `server/node_modules`**：旧版后端只依赖 Node 内置模块，新版依赖
   `better-sqlite3` + `bcryptjs`，必须先 `npm ci --omit=dev`，否则一启动就 `MODULE_NOT_FOUND`。
2. **`~/.cache` 是指向已不存在磁盘的坏软链**（`/mnt/nvme0n1/cache`），node-gyp 建缓存时报
   `ENOTDIR`。**不要改这个软链**（其他程序也在用），改用环境变量把本次构建的缓存指到别处：
   `XDG_CACHE_HOME` / `npm_config_cache` / `npm_config_devdir`。
3. **`better-sqlite3` 预编译二进制下载超时**：加 `--build-from-source` +
   `NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node` 后编译通过（服务器有 make/g++/python3）。

### 8.3 一次生产中断与纠正

切换构建时 `dist.new` 未上传成功，而命令写成
`mv dist dist.old-X && mv dist.new dist`——第二个 `mv` 失败**不会回退**第一个，导致 `dist` 被移走、
服务启动失败约 1 分钟。

**规则（写进流程，别再犯）**：

- 上传后先 `ls dist.new/src/index.js` 验货；
- 切换一律写成 `test -d dist.new && … && echo 切换完成`，任一步失败即中止；
- 只保留一个 `dist.old-*`，发布成功后再删上一个；
- 回滚 = `sudo systemctl stop … && rm -rf dist && mv dist.old-* dist && sudo systemctl start …`。

### 8.4 遗留事项

- 数据库**尚无自动备份**（`/var/lib/course-platform` 单点，硬盘故障即全丢）；
- 解析失败时 warn 日志记录模型原文前 120 字符（排错需要，暂无开关）；
- 验收结论与截图见 `docs/v3-v4-acceptance.md`。
