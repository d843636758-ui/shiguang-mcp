# 食光曲线

一个私密、自托管的餐食与血糖记录站点，同时提供 MCP 工具给 ChatGPT：

- 手机拍照记录一餐，浏览器端压缩并去除 EXIF 元数据
- 记录空腹、餐前、餐后 1 小时、餐后 2 小时、睡前或其他血糖
- 将血糖读数与具体餐次关联
- 由支持图片内容的 MCP 客户端读取餐照、估算热量区间和营养构成，再写回记录
- SQLite 与照片都保存在服务器持久卷；仓库不包含任何健康数据或密钥

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
cp .env.example .env
# 编辑 .env 后
npm start
```

打开 `http://localhost:3000`。MCP 地址为：

```text
http://localhost:3000/mcp/<MCP_TOKEN>
```

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
```

反向代理需将 HTTPS 域名转发至容器 `shiguang-mcp:3000`。不要把 `.env`、`data/` 或真实照片提交到 Git。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_meals` | 按时间范围列出餐次与已有估算 |
| `get_meal` | 获取一餐及关联血糖 |
| `get_meal_photo` | 返回餐照图像供模型观察 |
| `save_meal_estimate` | 保存热量区间、宏量营养素和分析说明 |
| `list_glucose_readings` | 获取血糖时间线 |
| `add_glucose_reading` | 由对话补记一条血糖 |
| `get_meal_response` | 查看一餐的餐前/餐后反应 |
| `get_period_summary` | 汇总一段时间的餐次与血糖数据 |

## 隐私与医疗说明

本项目用于个人记录与信息整理，不诊断、治疗或替代医生。照片与血糖属于敏感健康数据：请使用强密码、随机 MCP token、HTTPS，并定期备份 `/data`。

