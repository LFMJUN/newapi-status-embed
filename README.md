# New API Status Embed

一个适用于 `new-api` 的嵌入式模型状态页。

它会从 `new-api` 管理日志接口拉取请求数据，按模型和时间窗口聚合，然后输出一个适合放进 iframe 的状态监控页面。

适用场景：

- 你已经在使用 `new-api`
- 你想做一个独立的状态页子站
- 你想把状态页嵌入到主站的 `/about` 或其他页面

## Demo

![0d072174bfff1c0759810b8a5a902b44](https://img.act0r.net/https://raw.githubusercontent.com/LFMJUN/ilovekg/main/0d072174bfff1c0759810b8a5a902b44.webp)

## 功能特性

- 独立的 `/embed` 嵌入页
- 按模型显示状态卡片
- 支持 `1h / 6h / 12h / 24h` 时间窗口切换
- 自动刷新倒计时
- 时间分段状态方块
- 鼠标悬停 tooltip
- 支持从模型接口或日志中自动发现模型
- 支持通过环境变量限制显示的模型白名单

## 项目结构

- `server.js`：Node 服务端，负责聚合日志并提供接口
- `public/embed.html`：嵌入页入口
- `public/styles.css`：页面样式
- `public/app.js`：前端交互逻辑
- `.env.example`：环境变量示例
- `Dockerfile`：Docker 镜像构建文件
- `docker-compose.yml`：Docker Compose 启动文件

## 工作原理

1. 服务端请求 `new-api` 的管理日志接口
2. 分别拉取成功日志和错误日志
3. 按模型名和时间桶进行聚合
4. 输出给前端页面渲染
5. 页面通过 iframe 嵌入其他站点

## 环境变量

复制 `.env.example` 为 `.env`，然后填写：

```env
PORT=8787
NEWAPI_BASE_URL=https://your-newapi-domain.example.com
NEWAPI_ACCESS_TOKEN=replace-with-admin-access-token
NEWAPI_USER_ID=1
NEWAPI_MODEL_LIST_API_KEY=
DEFAULT_WINDOW=6h
REFRESH_INTERVAL=60
CACHE_TTL_SECONDS=30
DISPLAY_MODELS=
```

字段说明：

- `PORT`：服务监听端口，默认 `8787`
- `NEWAPI_BASE_URL`：你的 `new-api` 地址
- `NEWAPI_ACCESS_TOKEN`：管理员 Access Token，用于访问日志接口
- `NEWAPI_USER_ID`：管理员用户 ID，用于 `New-Api-User` 请求头
- `NEWAPI_MODEL_LIST_API_KEY`：普通 API key，可选，用于 `/v1/models` 模型发现
- `DEFAULT_WINDOW`：默认时间窗口，可选 `1h`、`6h`、`12h`、`24h`
- `REFRESH_INTERVAL`：前端刷新间隔秒数
- `CACHE_TTL_SECONDS`：服务端缓存时间
- `DISPLAY_MODELS`：逗号分隔的模型白名单，可留空

## Docker 部署教程

### 1. 上传项目到服务器

```bash
git clone https://github.com/LFMJUN/newapi-status-embed.git
```

### 2. 创建 `.env`

在项目根目录创建 `.env`，填入你的真实配置。

```bash
cp .env.example .env
```

### 3. 启动容器

```bash
cd ~/newapi-status-embed
docker compose up -d
```

### 4. 检查服务

```bash
docker compose ps
docker compose logs -f
```

### 5. 本机验证

在服务器本机验证：

- `http://你的服务器ip:8787/embed`
- `http://你的服务器:8787/api/health`

### 6. 更新代码

```bash
cd ~/newapi-status-embed
git pull
docker compose restart
```

## 常见问题

### 为什么有时只显示一个模型

常见原因：

- 管理模型接口返回空列表
- `/v1/models` 需要普通 API key，不能用管理员 Access Token
- 当前只有一个模型在最近日志里出现过

解决方式：

- 配置 `NEWAPI_MODEL_LIST_API_KEY`
- 或者直接用 `DISPLAY_MODELS` 指定模型白名单
