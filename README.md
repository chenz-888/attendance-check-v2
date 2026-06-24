# 公共网址签到系统

这是可部署到公网的签到/签退系统。用户扫码打开公共网址后填写姓名和学号/工号，允许定位，然后提交签到或签退。管理员可以在 `/admin.html` 查看所有记录并导出 CSV。

## 本地运行

```bash
ADMIN_PASSWORD=你的管理员密码 PORT=3000 npm start
```

打开：

- 签到页：`http://localhost:3000/`
- 后台页：`http://localhost:3000/admin.html`

## 部署需要准备

1. 一个可以运行 Node.js 的公网平台或服务器。
2. 设置环境变量 `ADMIN_PASSWORD`，不要使用默认密码。
3. 设置环境变量 `DATABASE_URL`，连接一个 PostgreSQL 数据库，用来长期保存签到记录。
4. 部署后得到公共网址，例如 `https://checkin.example.com`。
5. 用公共网址重新生成二维码，让所有人扫码签到。

## 数据长期保存

必须配置数据库，记录才会长期稳定保存。推荐使用 Render PostgreSQL、Supabase、Neon 或其他 PostgreSQL 数据库。

环境变量示例：

```bash
ADMIN_PASSWORD=你的管理员密码
DATABASE_URL=postgresql://用户名:密码@数据库地址:5432/数据库名
```

如果没有配置 `DATABASE_URL`，程序会拒绝签到，避免出现“看似保存成功但记录实际丢失”的情况。

## 重要提醒

- 手机定位要求 HTTPS。正式使用时请部署到 HTTPS 公共网址。
- 正式使用时一定要配置 `DATABASE_URL`。
- 如果人数很多、需要多管理员权限，建议进一步增加登录权限和数据筛选功能。
