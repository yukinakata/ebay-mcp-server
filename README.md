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
| `ebay_suggest_category` | eBayカテゴリ自動提案 |
| `ebay_get_item_aspects` | カテゴリ別必須項目取得 |
| `ebay_get_policies` | eBayポリシー一覧取得 |
| `ebay_create_listing` | eBay出品作成（SKU自動発行対応） |
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
4. Monitor APIからSKU自動取得（例: SKU-A1B2C3D4）
5. `ebay_create_listing` で出品
6. Monitor APIに商品登録（在庫監視開始）

## 価格計算ロジック

ebay-profit-calculatorスキル準拠（2025年2月改定）：

- eBay FVF: 12.7%（2025年2月14日改定）
- International Fee: 1.35%（日本セラー向け）
- Per-order Fee: $0.40（$10超）/ $0.30（$10以下）
- Payoneer手数料: 2%
- Payoneer為替スプレッド: 2%（実効レート 98%）
- SpeedPAK送料: 2025年1月16日改定版
- DDP関税: カテゴリ別（electronics 0%, default 15%等、2025-2026年相互関税適用）
- 通関手数料: ¥245（2025年10月改定）

## 開発

```bash
# 開発モード（TypeScript直接実行）
npm run dev

# ビルド
npm run build

# ウォッチモード
npm run watch
```
