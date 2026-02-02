# eBay MCP Server

Claude Desktop / Claude Code から利用可能な MCP サーバー。
Keepa API と eBay API を MCP ツールとして提供します。

## 機能

| ツール | 説明 |
|--------|------|
| `extract_asin` | Amazon URLからASINを抽出 |
| `keepa_get_product` | Keepa APIで商品情報を取得 |
| `keepa_get_tokens` | Keepa残りトークン確認 |
| `calculate_price` | ebay-profit-calculator準拠の価格計算 |
| `ebay_get_policies` | eBayポリシー一覧取得 |
| `ebay_create_listing` | eBay出品作成 |
| `ebay_update_quantity` | 在庫数更新 |

## セットアップ

### 1. 依存パッケージのインストール

```bash
cd /Users/nakata/Claude/ebay-mcp-server
npm install
```

### 2. ビルド

```bash
npm run build
```

### 3. 環境変数の設定

`.env` ファイルに API 認証情報を入力：

```
KEEPA_API_KEY=your_keepa_api_key
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_REFRESH_TOKEN=your_refresh_token
```

## Claude Desktop への登録

`~/Library/Application Support/Claude/claude_desktop_config.json` を編集：

```json
{
  "mcpServers": {
    "ebay": {
      "command": "node",
      "args": ["/Users/nakata/Claude/ebay-mcp-server/dist/index.js"],
      "env": {
        "KEEPA_API_KEY": "your_keepa_api_key",
        "EBAY_CLIENT_ID": "your_client_id",
        "EBAY_CLIENT_SECRET": "your_client_secret",
        "EBAY_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

## Claude Code への登録

Claude Code の設定ファイル（`.claude/settings.json` または `~/.claude.json`）に追加：

```json
{
  "mcpServers": {
    "ebay": {
      "command": "node",
      "args": ["/Users/nakata/Claude/ebay-mcp-server/dist/index.js"],
      "env": {
        "KEEPA_API_KEY": "your_keepa_api_key",
        "EBAY_CLIENT_ID": "your_client_id",
        "EBAY_CLIENT_SECRET": "your_client_secret",
        "EBAY_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

## 使用例（Claude との会話）

### 見積もりのみ

```
「https://amazon.co.jp/dp/B0BDHWDR12 の見積もりをして」
```

Claude が以下を実行：
1. `extract_asin` でASIN抽出
2. `keepa_get_product` で商品情報取得
3. `calculate_price` で価格計算

### 出品

```
「https://amazon.co.jp/dp/B0BDHWDR12 を粗利15%で出品して」
```

Claude が以下を実行：
1. ASIN抽出 → 商品情報取得
2. 翻訳・リスティング作成（Claudeが実行）
3. 価格計算
4. `ebay_create_listing` で出品

## 価格計算ロジック

ebay-profit-calculatorスキル準拠：

- eBay FVF: 13.25%
- International Fee: 1.65%
- Payoneer実効レート: ×0.975（2.5%の隠れコスト込み）
- SpeedPAK送料: 2025年1月16日改定版
- DDP関税: カテゴリ別（electronics 0%, default 10%等）

## 開発

```bash
# 開発モード（TypeScript直接実行）
npm run dev

# ビルド
npm run build

# ウォッチモード
npm run watch
```
