# API Probe Lab

跨平台桌面工具（macOS / Windows）：自动提取 Base URL 与 API Key，探测 OpenAI 兼容接口，列出模型，并支持真实多轮对话测试。

## 功能

- 从单行、多行和普通段落自动提取 **Base URL / API Key**，字段名可有可无
- 支持 JSON、YAML/TOML 风格、环境变量、curl、HTTP Header、命令行参数和 URL 查询参数
- API Key 支持明文、JWT、**Base64/Base64URL 自动解码**，并可递归解析编码后的 JSON/配置文本
- 支持无协议域名、完整 API 端点归一化，以及多 URL / Key 候选置信度排序
- 自动探测是否需要 **`/v1`**
- 拉取并展示 **模型列表**
- **真实多轮对话**（Enter 发送，Shift+Enter 换行）
- 多格式：`chat/completions` · `responses` · `messages`
- **系统代理自动读取**（macOS `scutil` / Windows 注册表 / 环境变量），支持手动修改
- HTTP / HTTPS / SOCKS5 代理测试

## 运行

```bash
npm install
npm start
```

开发模式：

```bash
npm run dev
```

## 打包

```bash
# macOS
npm run dist:mac

# Windows
npm run dist:win

# 全部
npm run dist:all
```

产物在 `release/`：

- macOS：`.dmg` / `.app`
- Windows：Portable `.exe` / `.zip` / NSIS 安装包

## 使用流程

1. 粘贴含链接和 Key 的文本 → **提取并探测模型**
2. 右侧点击模型（或手动填写）
3. 中间输入问题，**Enter** 或点 **发送**
4. 代理默认自动读取系统设置；可点 **读系统** 刷新，或手动改写

## 自动解析输入

解析器会尽量从混杂文本中寻找 URL 和 Key。以下形式都可以直接粘贴：

```text
https://api.example.com/v1 vendor_key-1234567890abcdef

BASE_URL=https://api.example.com/v1
API_KEY=vendor_key-1234567890abcdef

{"base_url":"https://api.example.com/v1","api_key":"vendor_key-1234567890abcdef"}

curl https://api.example.com/v1/models \
  -H "Authorization: Bearer vendor_key-1234567890abcdef"
```

完整的人工样例和自动化回归输入统一保存在 [`scripts/parser-test-cases.txt`](scripts/parser-test-cases.txt)，其中只使用虚构 Key。

## 技术栈

- Electron
- undici + https-proxy-agent + socks-proxy-agent

## License

MIT
