#!/usr/bin/env node
/**
 * eBay MCP Server v1.1.0
 * 
 * Claude Desktop / Claude Code から利用可能な MCP サーバー
 * Keepa API と eBay API を MCP ツールとして提供
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

// 環境変数読み込み（明示的にパスを指定）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ログファイル（MCPプロトコルと干渉しないようにファイルに書き出す）
const LOG_FILE = path.join(__dirname, "..", "mcp-debug.log");

function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
}

// ===========================================
// 定数定義（2025年2月改定版 - 正確な手数料率）
// ===========================================

// eBay手数料（2025年2月14日改定）
const EBAY_FVF_RATE = 0.127;           // Final Value Fee 12.7% (Most categories)
const EBAY_INTL_FEE_RATE = 0.0135;     // International Fee 1.35% (日本セラー向け)
const EBAY_PER_ORDER_FEE_HIGH = 0.40;  // Per-order fee ($10超)
const EBAY_PER_ORDER_FEE_LOW = 0.30;   // Per-order fee ($10以下)

// Payoneer手数料
const PAYONEER_FEE_RATE = 0.02;        // 決済手数料 2%
const PAYONEER_FX_SPREAD = 0.02;       // 為替スプレッド（隠しコスト）2%
const PAYONEER_EFFECTIVE_RATE = 1 - PAYONEER_FX_SPREAD;  // 為替実効レート 98%

// 合計手数料率（Per-order feeを除く）
const TOTAL_FEE_RATE = EBAY_FVF_RATE + EBAY_INTL_FEE_RATE + PAYONEER_FEE_RATE;

// 通関手数料（2025年10月改定）
const CUSTOMS_CLEARANCE_FEE_JPY = 245;

// DDP関税率（2025-2026年 実効税率 = MAX(MFN税率, 相互関税15%)）
// 日本からの輸入品に対する相互関税15%を考慮
const DDP_DUTY_RATES: Record<string, number> = {
  electronics: 0.0,    // ITA対象品は相互関税免除
  toys: 0.15,          // MFN 0% → 相互関税15%
  cosmetics: 0.15,     // MFN 0-6.5% → 相互関税15%
  tools: 0.15,         // MFN 2.5% → 相互関税15%
  food: 0.15,          // MFN 5% → 相互関税15%
  watches: 0.09,       // 複合税率の実効値（固定税＋ケース4-8.5%＋ストラップ14%＋バッテリー5.3%）
  jewelry: 0.15,       // MFN 6.5% → 相互関税15%
  clothing: 0.16,      // MFN 16%（追加関税なし）
  default: 0.15,       // MFN 10% → 相互関税15%
};

const DDP_PROCESSING_FEE_RATE = 0.021;

// SpeedPAK送料表（2025年1月16日改定版）
const SPEEDPAK_RATES: Record<string, Record<string, Record<number, number>>> = {
  US: {
    StandardA: { 500: 1367, 1000: 1724, 1500: 2081, 2000: 2303 },
    StandardB: { 500: 1659, 1000: 2017, 1500: 2374, 2000: 2587 },
    LargeA: { 1000: 2710, 2000: 3425, 3000: 4140, 4000: 4855, 5000: 5570 },
    LargeB: { 2000: 3790, 4000: 5220, 6000: 6650, 8000: 8080, 10000: 9510 },
  },
  EU: {
    StandardA: { 500: 1499, 1000: 1893, 1500: 2287, 2000: 2533 },
    StandardB: { 500: 1819, 1000: 2214, 1500: 2608, 2000: 2843 },
    LargeA: { 1000: 2971, 2000: 3754, 3000: 4537, 4000: 5320, 5000: 6103 },
    LargeB: { 2000: 4155, 4000: 5721, 6000: 7287, 8000: 8853, 10000: 10419 },
  },
  AU: {
    StandardA: { 500: 1581, 1000: 1996, 1500: 2411, 2000: 2671 },
    StandardB: { 500: 1918, 1000: 2334, 1500: 2749, 2000: 2999 },
    LargeA: { 1000: 3134, 2000: 3960, 3000: 4786, 4000: 5612, 5000: 6438 },
    LargeB: { 2000: 4383, 4000: 6035, 6000: 7687, 8000: 9339, 10000: 10991 },
  },
};

// EBAY_US のカテゴリツリーID
const EBAY_US_CATEGORY_TREE_ID = "0";

// Monitor API設定（環境変数から取得）
const MONITOR_API_URL = process.env.MONITOR_API_URL || "";
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || "";

// ===========================================
// ヘルパー関数
// ===========================================

/**
 * Monitor APIからSKUを自動取得
 * SKUが指定されていない場合に呼び出し、ユニークなSKUを発行
 */
async function generateSkuFromMonitor(): Promise<string | null> {
  debugLog(`[Monitor API] generateSkuFromMonitor called`);

  if (!MONITOR_API_URL || !MONITOR_API_KEY) {
    debugLog("[Monitor API] 未設定のため自動SKU生成をスキップ");
    return null;
  }

  try {
    const url = `${MONITOR_API_URL}/api/generate_sku.php?api_key=${encodeURIComponent(MONITOR_API_KEY)}`;
    debugLog(`[Monitor API] GETting SKU from: ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-Key": MONITOR_API_KEY,
      },
    });

    const result = await response.json() as any;
    debugLog(`[Monitor API] Response status: ${response.status}`);
    debugLog(`[Monitor API] Response body: ${JSON.stringify(result)}`);

    if (response.ok && result.success && result.sku) {
      debugLog(`[Monitor API] SKU生成成功: ${result.sku}`);
      return result.sku;
    } else {
      debugLog(`[Monitor API] SKU生成失敗: ${result.error || response.statusText}`);
      return null;
    }
  } catch (error: any) {
    debugLog(`[Monitor API] SKU生成エラー: ${error.message}`);
    return null;
  }
}

/**
 * Monitor APIに商品を登録
 * 出品成功後に呼び出し、監視システムにデータを送信
 */
async function registerToMonitor(data: {
  asin: string;
  sku: string;
  ebay_item_id: string;
  product_name?: string;
  brand?: string;
  model_number?: string;
  ebay_price_usd: number;
  current_price_jpy?: number;
  weight_g?: number;
  size_category?: string;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  // Keepa追加フィールド（last_checked_at設定用）
  stock_count?: number | null;
  shipping_days_min?: number | null;
  shipping_days_max?: number | null;
  is_prime?: boolean;
  image_url?: string | null;
  status?: string;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  debugLog(`[Monitor API] registerToMonitor called with ASIN: ${data.asin}, SKU: ${data.sku}`);

  if (!MONITOR_API_URL || !MONITOR_API_KEY) {
    debugLog("[Monitor API] 未設定のためスキップ");
    return { success: false, error: "Monitor API not configured" };
  }

  try {
    const url = `${MONITOR_API_URL}/api/register_product.php?api_key=${encodeURIComponent(MONITOR_API_KEY)}`;
    debugLog(`[Monitor API] POSTing to: ${url}`);
    debugLog(`[Monitor API] Body: ${JSON.stringify(data)}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": MONITOR_API_KEY,
      },
      body: JSON.stringify(data),
    });

    const result = await response.json() as any;
    debugLog(`[Monitor API] Response status: ${response.status}`);
    debugLog(`[Monitor API] Response body: ${JSON.stringify(result)}`);

    if (response.ok && result.success) {
      debugLog(`[Monitor API] 登録成功: ${data.sku} (Product ID: ${result.product_id})`);
      return { success: true, message: result.message };
    } else {
      debugLog(`[Monitor API] 登録失敗: ${result.error || response.statusText}`);
      return { success: false, error: result.error || response.statusText };
    }
  } catch (error: any) {
    debugLog(`[Monitor API] エラー: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function getSpeedpakRate(destination: string, sizeCategory: string, weightG: number): number {
  let zone = destination.toUpperCase();
  if (["UK", "DE", "FR", "IT", "ES"].includes(zone)) zone = "EU";
  if (!SPEEDPAK_RATES[zone]) zone = "US";

  const rates = SPEEDPAK_RATES[zone][sizeCategory] || SPEEDPAK_RATES[zone]["StandardA"];
  const sortedWeights = Object.keys(rates).map(Number).sort((a, b) => a - b);

  for (const maxWeight of sortedWeights) {
    if (weightG <= maxWeight) return rates[maxWeight];
  }
  return rates[sortedWeights[sortedWeights.length - 1]];
}

async function getExchangeRate(): Promise<number> {
  try {
    const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=JPY");
    const data = await response.json() as { rates: { JPY: number } };
    return data.rates.JPY;
  } catch {
    return 155.0;
  }
}

function extractAsin(urlOrAsin: string): string | null {
  if (/^[A-Z0-9]{10}$/i.test(urlOrAsin)) {
    return urlOrAsin.toUpperCase();
  }

  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
    /asin=([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
  ];

  for (const pattern of patterns) {
    const match = urlOrAsin.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

// ===========================================
// Keepa API
// ===========================================

// 必要トークン数の定数
const KEEPA_TOKENS_PER_REQUEST = 2; // 1リクエストで消費するトークン（余裕を持って2）
const KEEPA_MIN_TOKENS = 5; // 最低必要トークン数
const KEEPA_TOKENS_PER_MINUTE = 5; // 1分あたりの回復トークン数

async function keepaGetProduct(asin: string) {
  const apiKey = process.env.KEEPA_API_KEY;
  if (!apiKey) throw new Error("KEEPA_API_KEY が設定されていません");

  // トークン残量を事前チェック
  try {
    const tokensLeft = await keepaGetTokens();
    if (tokensLeft < KEEPA_MIN_TOKENS) {
      const tokensNeeded = KEEPA_MIN_TOKENS - tokensLeft;
      const waitMinutes = Math.ceil(tokensNeeded / KEEPA_TOKENS_PER_MINUTE);
      throw new Error(
        `Keepaトークン不足: 残り${tokensLeft}トークン（最低${KEEPA_MIN_TOKENS}必要）\n` +
        `約${waitMinutes}分後に再試行してください（1分あたり${KEEPA_TOKENS_PER_MINUTE}トークン回復）`
      );
    }
  } catch (e: any) {
    // トークンチェック自体のエラーは警告のみで続行
    if (e.message.includes("トークン不足")) {
      throw e; // トークン不足エラーは再スロー
    }
    debugLog(`[keepaGetProduct] Token check warning: ${e.message}`);
  }

  const url = `https://api.keepa.com/product?key=${apiKey}&domain=5&asin=${asin}&history=1&stats=1&offers=20`;
  const response = await fetch(url);
  const data = await response.json() as any;

  if (data.error) throw new Error(`Keepa API エラー: ${JSON.stringify(data.error)}`);
  if (!data.products || data.products.length === 0) throw new Error(`商品が見つかりません: ${asin}`);

  const product = data.products[0];

  // 価格取得（Amazon本体 or マーケットプレイス新品）
  let priceJpy: number | null = null;
  const stats = product.stats || {};
  const current = stats.current || [];
  if (current[1] && current[1] > 0) priceJpy = current[1]; // Amazon本体価格
  else if (current[10] && current[10] > 0) priceJpy = current[10]; // マーケットプレイス新品

  // 在庫数を取得
  // stockCount: null=データなし, -1=在庫あり(数量不明), 0=在庫切れ, 1+=在庫数
  let stockCount: number | null = null;
  const hasLiveOffers = product.liveOffersOrder && product.liveOffersOrder.length > 0;

  if (stats.stockAmazon && stats.stockAmazon > 0) {
    stockCount = stats.stockAmazon;
  } else if (stats.stockBuyBox && stats.stockBuyBox > 0) {
    stockCount = stats.stockBuyBox;
  } else if (product.offers && product.liveOffersOrder) {
    for (const idx of product.liveOffersOrder) {
      const offer = product.offers[idx];
      if (offer?.stockCSV && Array.isArray(offer.stockCSV) && offer.stockCSV.length >= 2) {
        const lastStock = offer.stockCSV[offer.stockCSV.length - 1];
        // lastStock > 0 の場合のみ在庫数として採用（0は信頼性が低いため無視）
        if (lastStock > 0) {
          stockCount = lastStock;
          if (offer.isAmazon || offer.isFBA) break;
        }
      }
    }
    // stockCSVがなくてもliveOffersOrderにオファーがあれば在庫あり
    // 価格が取得できている場合も在庫ありとみなす（current[1] or current[10]）
    if (stockCount === null && hasLiveOffers) {
      stockCount = -1; // 在庫あり（数量不明）
    }
  }

  // 価格が取得できている場合は在庫あり（数量不明）とみなす
  if (stockCount === null && (current[1] > 0 || current[10] > 0)) {
    stockCount = -1;
  }

  // オファー情報がない場合のみ、availabilityAmazonで判定
  const hasOfferData = product.offers && Object.keys(product.offers).length > 0;
  if (stockCount === null && !hasOfferData && product.availabilityAmazon === -1) {
    stockCount = 0;
  }

  // Prime対応チェック（配送日数より先に判定）
  let isPrime = false;
  if (product.offers && product.liveOffersOrder) {
    for (const idx of product.liveOffersOrder) {
      const offer = product.offers[idx];
      if (offer?.isPrime) {
        isPrime = true;
        break;
      }
    }
  }

  // 配送日数を取得
  let shippingDaysMin: number | null = null;
  let shippingDaysMax: number | null = null;
  if (product.shippingDelay && Array.isArray(product.shippingDelay)) {
    shippingDaysMin = Math.ceil(product.shippingDelay[0] / 24);
    shippingDaysMax = Math.ceil(product.shippingDelay[1] / 24);
  } else if (isPrime) {
    // Primeの場合、shippingDelayがなくても0-2日と推定
    shippingDaysMin = 0;
    shippingDaysMax = 2;
  }

  // 画像URL
  const images: string[] = [];
  let imageUrl: string | null = null;
  if (product.imagesCSV) {
    const codes = product.imagesCSV.split(",").slice(0, 5);
    for (const code of codes) {
      images.push(`https://images-na.ssl-images-amazon.com/images/I/${code}`);
    }
    if (codes.length > 0) {
      imageUrl = `https://images-na.ssl-images-amazon.com/images/I/${codes[0]}`;
    }
  }

  // ステータス判定
  // stockCount: null=データなし, -1=在庫あり(数量不明), 0=在庫切れ, 1+=在庫数
  let status = "正常";
  if (stockCount === null) {
    status = "データなし";
  } else if (stockCount === 0) {
    status = "在庫切れ";
  } else if (stockCount === -1) {
    status = "正常"; // 在庫あり（数量不明）
  } else if (stockCount === 1) {
    status = "ラスト1点";
  } else if (shippingDaysMax !== null && shippingDaysMax > 2) {
    status = "配送遅延";
  }

  return {
    asin: product.asin,
    title: product.title,
    price_jpy: priceJpy,
    stock_available: priceJpy !== null && priceJpy > 0,
    stock_count: stockCount,
    shipping_days_min: shippingDaysMin,
    shipping_days_max: shippingDaysMax,
    is_prime: isPrime,
    image_url: imageUrl,
    status,
    brand: product.brand,
    manufacturer: product.manufacturer,
    model: product.model,
    category: product.categoryTree?.slice(-1)[0]?.name || null,
    weight_g: product.itemWeight || null,
    package_weight_g: product.packageWeight || null,
    package_length_mm: product.packageLength || null,
    package_width_mm: product.packageWidth || null,
    package_height_mm: product.packageHeight || null,
    features: product.features || [],
    description: product.description || null,
    images,
  };
}

async function keepaGetTokens(): Promise<number> {
  const apiKey = process.env.KEEPA_API_KEY;
  if (!apiKey) throw new Error("KEEPA_API_KEY が設定されていません");

  const response = await fetch(`https://api.keepa.com/token?key=${apiKey}`);
  const data = await response.json() as { tokensLeft: number };
  return data.tokensLeft;
}

// ===========================================
// eBay API - トークン管理
// ===========================================

// User Access Token（出品・在庫管理用）
let ebayAccessToken: string | null = null;
let ebayTokenExpiresAt = 0;

// Application Token（Taxonomy API用 - ユーザー認証不要）
let ebayAppToken: string | null = null;
let ebayAppTokenExpiresAt = 0;

async function getEbayAccessToken(): Promise<string> {
  if (ebayAccessToken && Date.now() < ebayTokenExpiresAt) {
    return ebayAccessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("eBay API 認証情報が設定されていません");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.account",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay認証エラー: ${response.status} - ${error}`);
  }

  const tokenData = await response.json() as { access_token: string; expires_in: number };
  ebayAccessToken = tokenData.access_token;
  ebayTokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

  return ebayAccessToken;
}

// Application Token取得（Taxonomy API用）
async function getEbayAppToken(): Promise<string> {
  if (ebayAppToken && Date.now() < ebayAppTokenExpiresAt) {
    return ebayAppToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("eBay API 認証情報が設定されていません");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay App Token取得エラー: ${response.status} - ${error}`);
  }

  const tokenData = await response.json() as { access_token: string; expires_in: number };
  ebayAppToken = tokenData.access_token;
  ebayAppTokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

  return ebayAppToken;
}

// ===========================================
// eBay API - リクエスト
// ===========================================

async function ebayRequest(method: string, endpoint: string, body?: any): Promise<any> {
  const token = await getEbayAccessToken();

  const response = await fetch(`https://api.ebay.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return { success: true };

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay API エラー: ${response.status} - ${error}`);
  }

  return response.json();
}

async function ebayGetPolicies() {
  const [fulfillment, payment, returnPolicy] = await Promise.all([
    ebayRequest("GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US"),
    ebayRequest("GET", "/sell/account/v1/payment_policy?marketplace_id=EBAY_US"),
    ebayRequest("GET", "/sell/account/v1/return_policy?marketplace_id=EBAY_US"),
  ]);

  return {
    fulfillment_policies: fulfillment.fulfillmentPolicies || [],
    payment_policies: payment.paymentPolicies || [],
    return_policies: returnPolicy.returnPolicies || [],
  };
}

// Inventory Location作成（初回のみ）
const MERCHANT_LOCATION_KEY = "JP_SAITAMA";
let locationCreated = false;

async function ensureInventoryLocation() {
  if (locationCreated) return;

  const token = await getEbayAccessToken();

  try {
    // 既存のロケーションを確認
    const response = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.ok) {
      locationCreated = true;
      return;
    }

    // ロケーションが存在しない場合は作成（POSTメソッドを使用）
    if (response.status === 404) {
      const locationData = {
        location: {
          address: {
            city: "Saitama",
            stateOrProvince: "Saitama",
            country: "JP",
          },
        },
        merchantLocationStatus: "ENABLED",
        name: "Japan Warehouse",
        locationTypes: ["WAREHOUSE"],
      };

      const createResponse = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(locationData),
      });

      if (!createResponse.ok && createResponse.status !== 204) {
        const error = await createResponse.text();
        throw new Error(`Inventory Location作成エラー: ${createResponse.status} - ${error}`);
      }

      locationCreated = true;
    } else {
      const error = await response.text();
      throw new Error(`Inventory Location確認エラー: ${response.status} - ${error}`);
    }
  } catch (error: any) {
    throw new Error(`Inventory Location処理エラー: ${error.message}`);
  }
}

async function ebayCreateListing(params: {
  sku?: string;  // オプショナルに変更（未指定時はMonitor APIから自動取得）
  title: string;
  description: string;
  price_usd: number;
  category_id: string;
  quantity?: number;
  condition?: string;
  condition_description?: string;
  images?: string[];
  item_specifics?: Record<string, string>;
  weight_kg?: number;
  fulfillment_policy_id?: string;
  payment_policy_id?: string;
  return_policy_id?: string;
  // Monitor連携用（オプション）
  asin?: string;
  amazon_url?: string;  // 追加: Amazon URLから自動でASIN抽出
  current_price_jpy?: number;
  size_category?: string;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  // Keepaチェックスキップ
  skip_keepa_check?: boolean;
}) {
  let {
    sku,
    title,
    description,
    price_usd,
    category_id,
    quantity = 1,
    condition = "NEW",
    condition_description,
    images = [],
    item_specifics = {},
    weight_kg,
    fulfillment_policy_id,
    payment_policy_id,
    return_policy_id,
    // Monitor連携用
    asin: asinParam,
    amazon_url,
    current_price_jpy,
    size_category,
    length_cm,
    width_cm,
    height_cm,
    // Keepaチェックスキップオプション
    skip_keepa_check = false,
  } = params;

  // SKU自動取得（未指定の場合）
  if (!sku) {
    debugLog(`[ebayCreateListing] SKU未指定、Monitor APIから自動取得を試みます`);
    const generatedSku = await generateSkuFromMonitor();
    if (generatedSku) {
      sku = generatedSku;
      debugLog(`[ebayCreateListing] Monitor APIからSKU取得成功: ${sku}`);
    } else {
      // フォールバック: タイムスタンプベースのSKU生成
      sku = `SKU-${Date.now().toString(36).toUpperCase()}`;
      debugLog(`[ebayCreateListing] フォールバックSKU生成: ${sku}`);
    }
  }

  // 価格制限チェック: SpeedPAK Economyは$800未満のみ対応
  if (price_usd >= 800) {
    debugLog(`[ebayCreateListing] BLOCKED: Price $${price_usd} exceeds $800 SpeedPAK Economy limit`);
    return {
      success: false,
      error: "出品中止: 販売価格が$800以上です（SpeedPAK Economy制限）",
      reason: "price_exceeds_limit",
      price_usd,
      max_allowed: 800,
    };
  }

  // 説明文のサニタイズ（CDATAタグなど不要な文字を除去）
  const sanitizedDescription = description
    .replace(/<!\[CDATA\[/g, "")  // CDATA開始タグを除去
    .replace(/\]\]>/g, "")         // CDATA終了タグを除去
    .trim();

  // ASINの決定: asinパラメータ優先、なければamazon_urlから抽出、さらにSKUから抽出を試みる
  let asin = asinParam;
  debugLog(`[ebayCreateListing] Initial asin param: ${asinParam || "not provided"}`);
  debugLog(`[ebayCreateListing] amazon_url param: ${amazon_url || "not provided"}`);
  debugLog(`[ebayCreateListing] sku param: ${sku}`);

  if (!asin && amazon_url) {
    asin = extractAsin(amazon_url) || undefined;
    debugLog(`[ebayCreateListing] Extracted ASIN from URL: ${asin || "failed"}`);
  }
  // SKUにASINが含まれている場合も抽出（例: JP-B0BDHWDR12 → B0BDHWDR12）
  if (!asin && sku) {
    const skuAsinMatch = sku.match(/[A-Z0-9]{10}/i);
    if (skuAsinMatch) {
      asin = skuAsinMatch[0].toUpperCase();
      debugLog(`[ebayCreateListing] Extracted ASIN from SKU: ${asin}`);
    }
  }
  debugLog(`[ebayCreateListing] Final ASIN: ${asin || "NONE - Monitor API will NOT be called"}`);
  if (!asin) {
    debugLog(`[ebayCreateListing] WARNING: No ASIN available, product will NOT be registered to Monitor!`);
  }

  // ============================================
  // 出品前チェック: 在庫・配送日数を確認
  // ============================================
  if (skip_keepa_check) {
    debugLog(`[ebayCreateListing] Keepa check SKIPPED (skip_keepa_check=true)`);
  }

  // Keepaデータを保存（Monitor API登録時に使用）
  let keepaData: {
    title: string | null;
    brand: string | null;
    model: string | null;
    price_jpy: number | null;
    stock_count: number | null;
    shipping_days_min: number | null;
    shipping_days_max: number | null;
    is_prime: boolean;
    image_url: string | null;
    status: string;
  } | null = null;

  if (asin && process.env.KEEPA_API_KEY && !skip_keepa_check) {
    debugLog(`[ebayCreateListing] Checking stock and shipping for ASIN: ${asin}`);
    try {
      const keepaCheck = await keepaGetProduct(asin);

      // Keepaデータを保存（タイトル・価格も含む）
      keepaData = {
        title: keepaCheck.title,
        brand: keepaCheck.brand,
        model: keepaCheck.model,
        price_jpy: keepaCheck.price_jpy,
        stock_count: keepaCheck.stock_count,
        shipping_days_min: keepaCheck.shipping_days_min,
        shipping_days_max: keepaCheck.shipping_days_max,
        is_prime: keepaCheck.is_prime,
        image_url: keepaCheck.image_url,
        status: keepaCheck.status,
      };

      // 在庫チェック（価格が取得できない場合のみブロック）
      // stock_count=0でも価格があれば在庫ありとみなす
      if (!keepaCheck.price_jpy || keepaCheck.price_jpy <= 0) {
        debugLog(`[ebayCreateListing] BLOCKED: No price available (price: ${keepaCheck.price_jpy})`);
        return {
          success: false,
          error: "出品中止: Amazon価格が取得できません（在庫切れの可能性）",
          reason: "no_price",
          asin: asin,
          price_jpy: keepaCheck.price_jpy,
        };
      }

      // 配送日数チェック
      const maxShippingDays = 2; // 閾値: 2日以内なら許可
      if (keepaCheck.shipping_days_max !== null && keepaCheck.shipping_days_max > maxShippingDays) {
        debugLog(`[ebayCreateListing] BLOCKED: Shipping delay (shipping_days_max: ${keepaCheck.shipping_days_max})`);
        return {
          success: false,
          error: `出品中止: 配送遅延（発送まで${keepaCheck.shipping_days_max}日）`,
          reason: "shipping_delay",
          asin: asin,
          shipping_days_max: keepaCheck.shipping_days_max,
        };
      }

      debugLog(`[ebayCreateListing] Stock/Shipping check passed: stock=${keepaCheck.stock_count}, shipping_max=${keepaCheck.shipping_days_max}日`);
    } catch (e) {
      // Keepa APIエラーの場合は警告のみで続行（出品は許可）
      debugLog(`[ebayCreateListing] WARNING: Keepa check failed, proceeding anyway: ${e}`);
    }
  }

  // Aspects（Item Specifics）の整形
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(item_specifics)) {
    if (value) aspects[key] = [String(value)];
  }

  // Step 0: Inventory Locationの確認/作成
  await ensureInventoryLocation();

  // Step 1: Inventory Item 作成
  const inventoryItem: any = {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition,
    product: {
      title: title.substring(0, 80),
      description: sanitizedDescription,
      aspects,
      imageUrls: images.slice(0, 12),
    },
  };

  if (condition_description) {
    inventoryItem.conditionDescription = condition_description;
  }

  if (weight_kg) {
    inventoryItem.packageWeightAndSize = {
      weight: { value: weight_kg, unit: "KILOGRAM" },
    };
  }

  await ebayRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, inventoryItem);

  // Step 2: Offer 作成
  const offerData: any = {
    sku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    listingDuration: "GTC",
    pricingSummary: {
      price: { value: String(price_usd), currency: "USD" },
    },
    categoryId: category_id,
    quantityLimitPerBuyer: 3,
    merchantLocationKey: MERCHANT_LOCATION_KEY,
  };

  // デフォルトポリシーID（環境変数で設定可能）
  const defaultFulfillmentPolicyId = process.env.EBAY_DEFAULT_FULFILLMENT_POLICY_ID;
  const defaultPaymentPolicyId = process.env.EBAY_DEFAULT_PAYMENT_POLICY_ID;
  const defaultReturnPolicyId = process.env.EBAY_DEFAULT_RETURN_POLICY_ID;

  const listingPolicies: any = {};
  if (fulfillment_policy_id || defaultFulfillmentPolicyId) {
    listingPolicies.fulfillmentPolicyId = fulfillment_policy_id || defaultFulfillmentPolicyId;
  }
  if (payment_policy_id || defaultPaymentPolicyId) {
    listingPolicies.paymentPolicyId = payment_policy_id || defaultPaymentPolicyId;
  }
  if (return_policy_id || defaultReturnPolicyId) {
    listingPolicies.returnPolicyId = return_policy_id || defaultReturnPolicyId;
  }
  if (Object.keys(listingPolicies).length > 0) {
    offerData.listingPolicies = listingPolicies;
  }

  let offerId: string;
  try {
    const offerResult = await ebayRequest("POST", "/sell/inventory/v1/offer", offerData);
    offerId = offerResult.offerId;
  } catch (error: any) {
    // Offer already exists エラーの場合、既存のOfferIdを取得
    const match = error.message?.match(/"offerId","value":"(\d+)"/);
    if (match) {
      offerId = match[1];
    } else {
      throw error;
    }
  }

  // Step 3: Offer 公開
  const publishResult = await ebayRequest("POST", `/sell/inventory/v1/offer/${offerId}/publish/`);
  const listingId = publishResult.listingId;

  // Step 4: Monitor APIに登録（ASINが指定されている場合）
  let monitorResult: { success: boolean; message?: string; error?: string } | null = null;
  if (asin) {
    monitorResult = await registerToMonitor({
      asin,
      sku,
      ebay_item_id: listingId,
      // Keepaタイトル（日本語）を優先、なければeBayタイトル
      product_name: keepaData?.title || title,
      brand: keepaData?.brand || undefined,
      model_number: keepaData?.model || undefined,
      ebay_price_usd: price_usd,
      // Keepa価格を優先
      current_price_jpy: keepaData?.price_jpy ?? current_price_jpy,
      weight_g: weight_kg ? Math.round(weight_kg * 1000) : undefined,
      size_category,
      length_cm,
      width_cm,
      height_cm,
      // Keepaデータ（last_checked_atを設定するために必要）
      stock_count: keepaData?.stock_count,
      shipping_days_min: keepaData?.shipping_days_min,
      shipping_days_max: keepaData?.shipping_days_max,
      is_prime: keepaData?.is_prime,
      image_url: keepaData?.image_url,
      status: keepaData?.status,
    });
  }

  return {
    listing_id: listingId,
    sku,
    title,
    price_usd,
    ebay_url: `https://www.ebay.com/itm/${listingId}`,
    status: "active",
    monitor_registered: monitorResult?.success ?? false,
    monitor_message: monitorResult?.message || monitorResult?.error,
  };
}

async function ebayUpdateQuantity(sku: string, quantity: number) {
  const item = await ebayRequest("GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
  
  item.availability = {
    shipToLocationAvailability: { quantity },
  };

  await ebayRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, item);
  return { success: true, sku, quantity };
}

// ===========================================
// eBay Taxonomy API（カテゴリ自動提案）
// Application Tokenを使用（ユーザー認証不要）
// ===========================================

async function ebaySuggestCategory(query: string) {
  const token = await getEbayAppToken();
  
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}/get_category_suggestions?q=${encodedQuery}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay Taxonomy API エラー: ${response.status} - ${error}`);
  }

  const data = await response.json() as any;
  
  if (!data.categorySuggestions || data.categorySuggestions.length === 0) {
    return {
      query,
      suggestions: [],
      message: "カテゴリ候補が見つかりませんでした。キーワードを変更してみてください。",
    };
  }

  // カテゴリ候補を整形
  const suggestions = data.categorySuggestions.map((suggestion: any) => {
    const category = suggestion.category;
    const ancestors = suggestion.categoryTreeNodeAncestors || [];
    
    // パンくずリスト（カテゴリ階層）を作成
    const breadcrumb = [...ancestors.map((a: any) => a.categoryName).reverse(), category.categoryName].join(" > ");
    
    return {
      category_id: category.categoryId,
      category_name: category.categoryName,
      breadcrumb,
    };
  });

  return {
    query,
    suggestions: suggestions.slice(0, 5), // 上位5件
    best_match: suggestions[0],
  };
}

async function ebayGetItemAspects(categoryId: string) {
  const token = await getEbayAppToken();
  
  const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}/get_item_aspects_for_category?category_id=${categoryId}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay Taxonomy API エラー: ${response.status} - ${error}`);
  }

  const data = await response.json() as any;
  
  if (!data.aspects || data.aspects.length === 0) {
    return {
      category_id: categoryId,
      required_aspects: [],
      recommended_aspects: [],
      total_aspects: 0,
      message: "Item Aspectsが見つかりませんでした",
    };
  }

  // Item Aspectsを整形
  const aspects = data.aspects.map((aspect: any) => {
    const constraint = aspect.aspectConstraint || {};
    const values = aspect.aspectValues || [];
    
    return {
      name: aspect.localizedAspectName,
      required: constraint.aspectRequired || false,
      mode: constraint.aspectMode || "FREE_TEXT", // FREE_TEXT or SELECTION_ONLY
      data_type: constraint.aspectDataType || "STRING",
      max_values: constraint.itemToAspectCardinality === "MULTI" ? "MULTI" : "SINGLE",
      example_values: values.slice(0, 10).map((v: any) => v.localizedValue), // 上位10件の選択肢
    };
  });

  // 必須・推奨でソート
  const required = aspects.filter((a: any) => a.required);
  const recommended = aspects.filter((a: any) => !a.required);

  return {
    category_id: categoryId,
    required_aspects: required,
    recommended_aspects: recommended.slice(0, 15), // 推奨は上位15件
    total_aspects: aspects.length,
  };
}

// ===========================================
// 価格計算
// ===========================================

async function calculatePrice(params: {
  purchase_price_jpy: number;
  weight_g: number;
  size_category: string;
  destination?: string;
  category?: string;
  target_profit_rate?: number;
}) {
  const {
    purchase_price_jpy,
    weight_g,
    size_category,
    destination = "US",
    category = "default",
    target_profit_rate = 0.15,
  } = params;

  const exchangeRate = await getExchangeRate();
  const shippingJpy = getSpeedpakRate(destination, size_category, weight_g);
  const effectiveRate = exchangeRate * PAYONEER_EFFECTIVE_RATE;
  const dutyRate = DDP_DUTY_RATES[category.toLowerCase()] || DDP_DUTY_RATES.default;

  // 反復計算（Per-order feeと通関手数料を考慮）
  let priceUsd = 50.0;
  for (let i = 0; i < 20; i++) {
    // Per-order fee（金額別）
    const perOrderFee = priceUsd > 10 ? EBAY_PER_ORDER_FEE_HIGH : EBAY_PER_ORDER_FEE_LOW;

    // DDP費用（関税額に対して2.1%の処理手数料）
    const dutyUsd = priceUsd * dutyRate;
    const ddpProcessingUsd = dutyUsd * DDP_PROCESSING_FEE_RATE;
    const ddpTotalUsd = dutyUsd + ddpProcessingUsd;
    const ddpJpy = ddpTotalUsd * exchangeRate;

    // 総コスト（通関手数料¥245を含む）
    const totalCostJpy = purchase_price_jpy + shippingJpy + ddpJpy + CUSTOMS_CLEARANCE_FEE_JPY;

    // 必要な売上（目標粗利率から逆算）
    const requiredRevenueJpy = totalCostJpy / (1 - target_profit_rate);

    // eBay手数料とPayoneer手数料を考慮した販売価格
    // 売上 = (販売価格 - eBay手数料 - Per-order fee) × (1 - Payoneer手数料) × 為替実効レート
    // eBay手数料 = 販売価格 × (FVF + International Fee)
    const payoneerNetRate = (1 - PAYONEER_FEE_RATE) * effectiveRate;
    const newPriceUsd = (requiredRevenueJpy / payoneerNetRate + perOrderFee) / (1 - EBAY_FVF_RATE - EBAY_INTL_FEE_RATE);

    if (Math.abs(newPriceUsd - priceUsd) < 0.01) break;
    priceUsd = newPriceUsd;
  }

  // 最終価格（$X.99形式）
  const finalPriceUsd = Math.max(Math.round(priceUsd) - 0.01, 0.99);

  // 実際の粗利計算
  const perOrderFeeFinal = finalPriceUsd > 10 ? EBAY_PER_ORDER_FEE_HIGH : EBAY_PER_ORDER_FEE_LOW;
  const ebayFeesUsd = finalPriceUsd * (EBAY_FVF_RATE + EBAY_INTL_FEE_RATE) + perOrderFeeFinal;
  const payoneerDepositUsd = finalPriceUsd - ebayFeesUsd;
  const payoneerFeeUsd = payoneerDepositUsd * PAYONEER_FEE_RATE;
  const netRevenueUsd = payoneerDepositUsd - payoneerFeeUsd;
  // Payoneer手数料（2%）を引いた後、為替スプレッド（2%）を適用
  const actualNetJpy = netRevenueUsd * effectiveRate;

  // DDP費用
  const dutyFinalUsd = finalPriceUsd * dutyRate;
  const ddpProcessingFinalUsd = dutyFinalUsd * DDP_PROCESSING_FEE_RATE;
  const ddpFinalJpy = (dutyFinalUsd + ddpProcessingFinalUsd) * exchangeRate;

  // 総コスト
  const totalCostFinalJpy = purchase_price_jpy + shippingJpy + ddpFinalJpy + CUSTOMS_CLEARANCE_FEE_JPY;

  // 粗利
  const profitJpy = actualNetJpy - totalCostFinalJpy;
  // profitRateは%表示（Monitor側と統一）: 15.0 = 15%
  const profitRate = actualNetJpy > 0 ? (profitJpy / actualNetJpy) * 100 : 0;

  return {
    selling_price_usd: finalPriceUsd,
    shipping_jpy: shippingJpy,
    ddp_jpy: Math.round(ddpFinalJpy),
    customs_fee_jpy: CUSTOMS_CLEARANCE_FEE_JPY,
    total_cost_jpy: Math.round(totalCostFinalJpy),
    estimated_profit_jpy: Math.round(profitJpy),
    profit_rate: Math.round(profitRate * 10) / 10,  // 小数点1桁（例: 15.2%）
    exchange_rate: exchangeRate,
    effective_rate: effectiveRate,
    ebay_fees_usd: Math.round(ebayFeesUsd * 100) / 100,
  };
}

// ===========================================
// MCP ツール定義
// ===========================================

const tools: Tool[] = [
  {
    name: "extract_asin",
    description: "Amazon URLまたはASINからASINを抽出します",
    inputSchema: {
      type: "object",
      properties: {
        url_or_asin: {
          type: "string",
          description: "Amazon URL または ASIN",
        },
      },
      required: ["url_or_asin"],
    },
  },
  {
    name: "keepa_get_product",
    description: "Keepa APIを使用してAmazon商品の情報を取得します（価格、在庫、画像、重量など）",
    inputSchema: {
      type: "object",
      properties: {
        asin: {
          type: "string",
          description: "Amazon ASIN（10文字の英数字）",
        },
      },
      required: ["asin"],
    },
  },
  {
    name: "keepa_get_tokens",
    description: "Keepa APIの残りトークン数を確認します",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calculate_price",
    description: "ebay-profit-calculatorスキル準拠の価格計算。仕入れ価格・重量・サイズから、目標粗利率を達成するeBay販売価格を算出します",
    inputSchema: {
      type: "object",
      properties: {
        purchase_price_jpy: {
          type: "number",
          description: "仕入れ価格（円）",
        },
        weight_g: {
          type: "number",
          description: "重量（グラム）",
        },
        size_category: {
          type: "string",
          enum: ["StandardA", "StandardB", "LargeA", "LargeB"],
          description: "SpeedPAKサイズ区分",
        },
        destination: {
          type: "string",
          enum: ["US", "UK", "EU", "AU"],
          description: "送付先（デフォルト: US）",
        },
        category: {
          type: "string",
          description: "商品カテゴリ（DDP関税率決定用: electronics, toys, clothing, watches, tools, default）",
        },
        target_profit_rate: {
          type: "number",
          description: "目標粗利率（デフォルト: 0.15 = 15%）",
        },
      },
      required: ["purchase_price_jpy", "weight_g", "size_category"],
    },
  },
  {
    name: "ebay_suggest_category",
    description: "商品タイトルやキーワードからeBayカテゴリを自動提案します。最適なカテゴリIDとカテゴリ階層（パンくずリスト）を返します",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索クエリ（商品タイトルまたはキーワード、英語推奨）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ebay_get_item_aspects",
    description: "指定したカテゴリIDの必須・推奨Item Specifics（商品詳細項目）を取得します",
    inputSchema: {
      type: "object",
      properties: {
        category_id: {
          type: "string",
          description: "eBayカテゴリID",
        },
      },
      required: ["category_id"],
    },
  },
  {
    name: "ebay_get_policies",
    description: "eBayの配送・支払い・返品ポリシー一覧を取得します",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ebay_create_listing",
    description: "eBayに新規出品を作成します（Inventory Item作成 → Offer作成 → 公開）。SKU未指定時はMonitor APIから自動発行。",
    inputSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "商品SKU（オプショナル。未指定時はMonitor APIから自動発行、例: SKU-A1B2C3D4）",
        },
        title: {
          type: "string",
          description: "英語タイトル（80文字以内）",
        },
        description: {
          type: "string",
          description: "英語説明文（HTML可）",
        },
        price_usd: {
          type: "number",
          description: "販売価格（USD）",
        },
        category_id: {
          type: "string",
          description: "eBayカテゴリID",
        },
        quantity: {
          type: "number",
          description: "数量（デフォルト: 1）",
        },
        condition: {
          type: "string",
          description: "商品状態（デフォルト: NEW）",
        },
        condition_description: {
          type: "string",
          description: "商品状態の説明",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "画像URLリスト（最大12枚）",
        },
        item_specifics: {
          type: "object",
          description: "Item Specifics（Brand, MPN等）",
        },
        weight_kg: {
          type: "number",
          description: "重量（kg）",
        },
        fulfillment_policy_id: {
          type: "string",
          description: "配送ポリシーID",
        },
        payment_policy_id: {
          type: "string",
          description: "支払いポリシーID",
        },
        return_policy_id: {
          type: "string",
          description: "返品ポリシーID",
        },
        asin: {
          type: "string",
          description: "Amazon ASIN（Monitor連携用、指定すると自動で監視システムに登録）",
        },
        amazon_url: {
          type: "string",
          description: "Amazon URL（Monitor連携用、URLからASINを自動抽出して監視システムに登録）",
        },
        current_price_jpy: {
          type: "number",
          description: "Amazon仕入れ価格（円、Monitor連携用）",
        },
        size_category: {
          type: "string",
          description: "SpeedPAKサイズ区分（StandardA/StandardB/LargeA/LargeB、Monitor連携用）",
        },
        length_cm: {
          type: "number",
          description: "パッケージ長さ（cm、Monitor連携用）",
        },
        width_cm: {
          type: "number",
          description: "パッケージ幅（cm、Monitor連携用）",
        },
        height_cm: {
          type: "number",
          description: "パッケージ高さ（cm、Monitor連携用）",
        },
        skip_keepa_check: {
          type: "boolean",
          description: "trueにするとKeepaによる在庫・配送チェックをスキップ（トークン節約用）",
        },
      },
      required: ["title", "description", "price_usd", "category_id"],
    },
  },
  {
    name: "ebay_update_quantity",
    description: "eBay出品の在庫数を更新します（0にすると出品停止）",
    inputSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "商品SKU",
        },
        quantity: {
          type: "number",
          description: "新しい在庫数",
        },
      },
      required: ["sku", "quantity"],
    },
  },
];

// ===========================================
// MCP サーバー起動
// ===========================================

const server = new Server(
  {
    name: "ebay-mcp-server",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// ツール実行
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: any;

    switch (name) {
      case "extract_asin":
        const asin = extractAsin(args.url_or_asin as string);
        if (!asin) throw new Error("ASINを抽出できませんでした");
        result = { asin };
        break;

      case "keepa_get_product":
        result = await keepaGetProduct(args.asin as string);
        break;

      case "keepa_get_tokens":
        const tokens = await keepaGetTokens();
        result = { tokens_left: tokens };
        break;

      case "calculate_price":
        result = await calculatePrice(args as any);
        break;

      case "ebay_suggest_category":
        result = await ebaySuggestCategory(args.query as string);
        break;

      case "ebay_get_item_aspects":
        result = await ebayGetItemAspects(args.category_id as string);
        break;

      case "ebay_get_policies":
        result = await ebayGetPolicies();
        break;

      case "ebay_create_listing":
        result = await ebayCreateListing(args as any);
        break;

      case "ebay_update_quantity":
        result = await ebayUpdateQuantity(args.sku as string, args.quantity as number);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `エラー: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debugLog("eBay MCP Server v1.1.0 started");
  debugLog(`[Config] MONITOR_API_URL: ${MONITOR_API_URL || "NOT SET"}`);
  debugLog(`[Config] MONITOR_API_KEY: ${MONITOR_API_KEY ? MONITOR_API_KEY.substring(0, 10) + "..." : "NOT SET"}`);
}

main().catch(console.error);
