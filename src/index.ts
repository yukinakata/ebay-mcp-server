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
// 定数定義（2026年2月改定 - 実取引データ照合済み）
// ===========================================

// eBay手数料（段階制FVF + 消費税）
const EBAY_FVF_RATE_WATCHES_T1 = 0.15;   // Watches ～$1,000: 15%
const EBAY_FVF_RATE_WATCHES_T2 = 0.065;  // Watches $1,000超～$7,500: 6.5%
const EBAY_FVF_RATE_WATCHES_T3 = 0.03;   // Watches $7,500超: 3%
const EBAY_FVF_RATE_DEFAULT = 0.136;      // Most categories: 13.6%
const EBAY_INTL_FEE_RATE = 0.0135;        // International Fee 1.35% (日本セラー向け)
const EBAY_PER_ORDER_FEE_HIGH = 0.40;     // Per-order fee ($10超)
const EBAY_PER_ORDER_FEE_LOW = 0.30;      // Per-order fee ($10以下)
const EBAY_TAX_ON_FEES_RATE = 0.10;       // 消費税10%（手数料に対して）

// Payoneer（FXマークアップのみ、決済手数料なし）
const PAYONEER_FX_MARKUP = 0.025;         // 為替マークアップ 2.5%
const PAYONEER_EFFECTIVE_RATE = 1 - PAYONEER_FX_MARKUP;  // 実効レート 97.5%

// 通関手数料（2025年10月改定）
const CUSTOMS_CLEARANCE_FEE_JPY = 245;

// 米国Sales Tax推定（SpeedPAK DDPで立替、州平均7%）
const US_SALES_TAX_RATE = 0.07;

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
  product_category?: string;
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

  // 価格取得（Prime価格優先）
  // FBA(current[10]) ≠ 必ずPrime → offers内のisPrimeフラグを直接チェック
  // offerCSVは価格履歴 [time,price,shipping,...] → 最新価格は末尾から2番目
  let priceJpy: number | null = null;
  const stats = product.stats || {};
  const current = stats.current || [];
  const amazonDirectPrice = (current[0] && current[0] > 0) ? current[0] : null; // Amazon本体（常にPrime）

  // 1. offers配列からisPrime=true または isAmazon=true の最安値を探す
  let bestPrimePrice: number | null = null;
  if (product.offers && product.liveOffersOrder) {
    for (const idx of product.liveOffersOrder) {
      const offer = product.offers[idx];
      if (!offer?.offerCSV || offer.offerCSV.length < 3) continue;
      // offerCSV = [time, price, shipping, time, price, shipping, ...] → 最新価格は末尾から2番目
      const offerPrice = offer.offerCSV[offer.offerCSV.length - 2];
      if (offerPrice <= 0) continue;
      if (offer.isPrime || offer.isAmazon) {
        if (bestPrimePrice === null || offerPrice < bestPrimePrice) {
          bestPrimePrice = offerPrice;
        }
      }
    }
  }

  // 2. Amazon本体価格(current[0])とoffers内Prime最安値を比較、安い方を選択
  if (amazonDirectPrice && bestPrimePrice) {
    priceJpy = Math.min(amazonDirectPrice, bestPrimePrice);
  } else if (amazonDirectPrice) {
    priceJpy = amazonDirectPrice;
  } else if (bestPrimePrice) {
    priceJpy = bestPrimePrice;
  }

  // 3. Prime価格が取得できない場合、current[10](FBA)にフォールバック
  if (!priceJpy && current[10] && current[10] > 0) {
    priceJpy = current[10];
  }

  // 4. それでも取得できない場合、全新品最安値(current[1])にフォールバック
  if (!priceJpy && current[1] && current[1] > 0) priceJpy = current[1];

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
  // Amazon本体(isAmazon)は常にPrime扱い（KeepaのisPrimeフラグが未設定でも）
  let isPrime = false;
  if (product.offers && product.liveOffersOrder) {
    for (const idx of product.liveOffersOrder) {
      const offer = product.offers[idx];
      if (offer?.isPrime || offer?.isAmazon) {
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
  } else {
    // 非Primeの場合、shippingDelayがなければ3-7日と推定
    shippingDaysMin = 3;
    shippingDaysMax = 7;
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
    // 追加属性（Keepa APIから取得可能なフィールド）
    color: product.color || null,
    size: product.size || null,
    materials: product.materials || [],
    countryOfOrigin: product.countryOfOrigin || null,
  };
}

// 腕時計Item Specificsを指定順序で構築
function buildWatchItemSpecifics(keepaData: any): Array<{name: string, value: string}> {
  const title = keepaData.title || "";
  const features: string[] = keepaData.features || [];
  const desc = keepaData.description || "";
  const allText = (title + " " + features.join(" ") + " " + desc).toLowerCase();

  // --- Department ---
  let department = "";
  if (/メンズ|男性|men'?s\b|for men\b/i.test(title)) department = "Men";
  else if (/レディース|女性|women'?s\b|for women|ladies/i.test(title)) department = "Women";
  else if (/ユニセックス|unisex|兼用/i.test(title)) department = "Unisex";
  else if (/g-shock|gショック|ジーショック|プロトレック|protrek|oceanus|オシアナス/i.test(title)) department = "Men";

  // --- Features (max 5, eBay用短縮キーワード) ---
  const feat: string[] = [];
  if (/stopwatch|ストップウォッチ/i.test(allText)) feat.push("Stopwatch");
  if (/alarm|アラーム/i.test(allText)) feat.push("Alarm");
  if (/backlight|バックライト|illuminator|ライト/i.test(allText)) feat.push("Backlight");
  if (/calendar|カレンダー|日付/i.test(allText)) feat.push("Calendar");
  if (/shock.?resist|耐衝撃/i.test(allText)) feat.push("Shock Resistant");
  if (/bluetooth/i.test(allText)) feat.push("Bluetooth");
  if (/gps/i.test(allText)) feat.push("GPS");
  if (/solar|ソーラー|タフソーラー|eco.?drive/i.test(allText)) feat.push("Solar Powered");
  if (/電波|atomic|multi.?band|マルチバンド|radio.?control/i.test(allText)) feat.push("Radio Controlled");
  if (/compass|コンパス/i.test(allText)) feat.push("Compass");
  if (/altimeter|高度計/i.test(allText)) feat.push("Altimeter");
  if (/barometer|気圧/i.test(allText)) feat.push("Barometer");
  if (/thermometer|温度/i.test(allText)) feat.push("Thermometer");
  if (/timer|タイマー/i.test(allText)) feat.push("Timer");
  if (/world.?time|ワールドタイム/i.test(allText)) feat.push("World Time");

  // --- Movement ---
  let movement = "";
  if (/ソーラー|solar|タフソーラー|tough solar|eco.?drive|エコドライブ/i.test(allText)) {
    movement = "Solar Powered";
  } else if (/自動巻|automatic|mechanical|メカニカル|機械式/i.test(allText)) {
    movement = "Mechanical (Automatic)";
  } else if (/クォーツ|クオーツ|quartz/i.test(allText)) {
    movement = "Japanese Quartz";
  } else if (/kinetic|キネティック/i.test(allText)) {
    movement = "Kinetic";
  } else if (/casio|カシオ|g-shock/i.test(title)) {
    movement = "Japanese Quartz";
  }

  // --- Band Material ---
  let bandMaterial = "";
  if (/レジン|resin|ウレタン|urethane|ラバー|rubber|シリコン|silicone/i.test(allText)) bandMaterial = "Resin";
  else if (/ナイロン|nylon|nato/i.test(allText)) bandMaterial = "Nylon";
  else if (/レザー|leather|革|皮/i.test(allText)) bandMaterial = "Leather";
  else if (/チタン|titanium/i.test(allText)) bandMaterial = "Titanium";
  else if (/ステンレス|stainless/i.test(allText)) bandMaterial = "Stainless Steel";

  // --- Case Material ---
  let caseMaterial = "";
  if (/カーボン|carbon/i.test(allText)) caseMaterial = "Carbon Fiber";
  else if (/チタン|titanium/i.test(allText)) caseMaterial = "Titanium";
  else if (/ステンレス|stainless/i.test(allText)) caseMaterial = "Stainless Steel";
  else if (/レジン|resin|プラスチック|plastic/i.test(allText)) caseMaterial = "Resin";

  // --- Display ---
  let display = "";
  if (/アナデジ|ana-digi|analog.*digital|digital.*analog/i.test(allText)) display = "Ana-Digi";
  else if (/デジタル|digital/i.test(allText)) display = "Digital";
  else if (/アナログ|analog/i.test(allText)) display = "Analog";

  // --- Water Resistance ---
  let waterResistance = "";
  const wrBar = allText.match(/(\d+)\s*(bar|気圧|atm)/i);
  const wrM = allText.match(/(\d+)\s*(m|メートル)\b/i);
  if (wrBar) {
    waterResistance = `${parseInt(wrBar[1]) * 10}m`;
  } else if (wrM) {
    waterResistance = `${parseInt(wrM[1])}m`;
  }

  // --- Style ---
  let style = "";
  if (/g-shock|sport|スポーツ|outdoor|アウトドア|dive|ダイバー|protrek/i.test(allText)) style = "Sport";
  else if (/dress|ドレス|formal|フォーマル/i.test(allText)) style = "Dress";
  else if (/luxury|高級|プレミアム|prestige|グランド/i.test(allText)) style = "Luxury";
  else style = "Casual";

  // --- Country of Origin ---
  let countryOfOrigin = "";
  const keepaOrigin = (keepaData.countryOfOrigin || "").toLowerCase();
  if (keepaOrigin === "japan" || keepaOrigin === "日本" || /^jp$/i.test(keepaOrigin)) countryOfOrigin = "Japan";
  else if (/原産国.*日本|原産国.*japan/i.test(allText)) countryOfOrigin = "Japan";
  else if (/日本製|made in japan/i.test(allText)) countryOfOrigin = "Japan";
  else if (/国内正規品/.test(title)) countryOfOrigin = "Japan";
  else if (/japanese.?movement|miyota|seiko.*movement|日本製ムーブメント/i.test(allText)) countryOfOrigin = "Japan";

  // --- Color (Keepaのcolorフィールドから) ---
  const color = keepaData.color || "";

  return [
    { name: "Brand", value: keepaData.brand || "" },
    { name: "Department", value: department },
    { name: "Type", value: "Wristwatch" },
    { name: "UPC", value: "" },
    { name: "Reference Number", value: keepaData.model || "" },
    { name: "Customized", value: "No" },
    { name: "Model", value: keepaData.model || "" },
    { name: "Features", value: feat.slice(0, 5).join(", ") },
    { name: "Movement", value: movement },
    { name: "Band Color", value: "" },
    { name: "Band Material", value: bandMaterial },
    { name: "Case Color", value: "" },
    { name: "Case Material", value: caseMaterial },
    { name: "Display", value: display },
    { name: "Water Resistance", value: waterResistance },
    { name: "Indices", value: "" },
    { name: "Dial Color", value: "" },
    { name: "Year Manufactured", value: "" },
    { name: "Style", value: style },
    { name: "With Original Box/Packaging", value: "Yes" },
    { name: "With Papers", value: "Yes" },
    { name: "Case Size", value: "" },
    { name: "Watch Shape", value: "" },
    { name: "Country of Origin", value: countryOfOrigin },
    { name: "Number of Jewels", value: "" },
    { name: "Caseback", value: "" },
    { name: "Case Finish", value: "" },
    { name: "Lug Width", value: "" },
    { name: "With Manual/Booklet", value: "Yes" },
    { name: "With Service Records", value: "No" },
    { name: "Manufacturer Warranty", value: "" },
    { name: "Band Width", value: "" },
    { name: "California Prop 65 Warning", value: "" },
    { name: "Case Thickness", value: "" },
    { name: "Escapement Type", value: "" },
    { name: "Handedness", value: "" },
    { name: "Handmade", value: "" },
    { name: "Seller Warranty", value: "" },
    { name: "Theme", value: "" },
    { name: "Vintage", value: "No" },
    { name: "Closure", value: "" },
    { name: "Band/Strap", value: "" },
    { name: "Bezel Color", value: "" },
    { name: "Bezel Type", value: "" },
    { name: "Dial Pattern", value: "" },
    { name: "Max Wrist Size", value: "" },
    { name: "Unit Quantity", value: "" },
    { name: "Unit Type", value: "" },
  ];
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
let tokenRefreshPromise: Promise<string> | null = null;

// Application Token（Taxonomy API用 - ユーザー認証不要）
let ebayAppToken: string | null = null;
let ebayAppTokenExpiresAt = 0;
let appTokenRefreshPromise: Promise<string> | null = null;

async function getEbayAccessToken(): Promise<string> {
  if (ebayAccessToken && Date.now() < ebayTokenExpiresAt) {
    return ebayAccessToken;
  }

  // 既にリフレッシュ中なら、その結果を待つ（競合条件防止）
  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    try {
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
    } finally {
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

// Application Token取得（Taxonomy API用）
async function getEbayAppToken(): Promise<string> {
  if (ebayAppToken && Date.now() < ebayAppTokenExpiresAt) {
    return ebayAppToken;
  }

  // 既にリフレッシュ中なら、その結果を待つ（競合条件防止）
  if (appTokenRefreshPromise) {
    return appTokenRefreshPromise;
  }

  appTokenRefreshPromise = (async () => {
    try {
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
    } finally {
      appTokenRefreshPromise = null;
    }
  })();

  return appTokenRefreshPromise;
}

// ===========================================
// eBay API - リクエスト
// ===========================================

async function ebayRequest(method: string, endpoint: string, body?: any, maxRetries = 3): Promise<any> {
  const url = `https://api.ebay.com${endpoint}`;

  debugLog(`[ebayRequest] ${method} ${endpoint}`);
  if (body) {
    const bodyStr = JSON.stringify(body);
    const logBody = bodyStr.length > 2000
      ? bodyStr.substring(0, 2000) + `... (truncated, total ${bodyStr.length} chars)`
      : bodyStr;
    debugLog(`[ebayRequest] Body: ${logBody}`);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const token = await getEbayAccessToken();

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "en-US",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    debugLog(`[ebayRequest] Response: ${response.status} ${response.statusText}`);

    if (response.status === 204) return { success: true };

    if (response.ok) return response.json();

    const errorText = await response.text();

    // 5xxエラーはリトライ対象（最終試行以外）
    if (response.status >= 500 && attempt < maxRetries - 1) {
      const waitMs = Math.min(1000 * Math.pow(2, attempt), 10000);
      debugLog(`[ebayRequest] ${response.status} error, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    debugLog(`[ebayRequest] ERROR: ${errorText}`);
    throw new Error(`eBay API エラー: ${response.status} - ${errorText}`);
  }

  throw new Error(`eBay API エラー: max retries (${maxRetries}) exceeded`);
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
  product_category?: string;  // DDP関税率決定用（watches/electronics/toys等）
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
    product_category = "default",  // デフォルトは 'default' (15%関税)
    length_cm,
    width_cm,
    height_cm,
    // Keepaチェックスキップオプション
    skip_keepa_check = false,
  } = params;

  // 入力値バリデーション
  if (!Number.isFinite(price_usd) || price_usd <= 0) {
    return {
      success: false,
      error: `出品中止: 無効な価格です（price_usd: ${price_usd}）。正の数値を指定してください。`,
      reason: "invalid_price",
    };
  }
  if (price_usd < 1) {
    return {
      success: false,
      error: `出品中止: 価格が低すぎます（$${price_usd}）。最低$1.00以上を指定してください。`,
      reason: "price_too_low",
    };
  }
  if (weight_kg !== undefined && (!Number.isFinite(weight_kg) || weight_kg <= 0)) {
    return {
      success: false,
      error: `出品中止: 無効な重量です（weight_kg: ${weight_kg}）。正の数値を指定してください。`,
      reason: "invalid_weight",
    };
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

  // ============================================
  // ASIN抽出とSKU決定（シンプル版）
  // ============================================
  let asin = asinParam;
  debugLog(`[ebayCreateListing] asin param: ${asinParam || "not provided"}`);
  debugLog(`[ebayCreateListing] amazon_url param: ${amazon_url || "not provided"}`);

  // amazon_urlからASINを抽出
  if (!asin && amazon_url) {
    asin = extractAsin(amazon_url) || undefined;
    debugLog(`[ebayCreateListing] Extracted ASIN from amazon_url: ${asin || "failed"}`);
  }

  debugLog(`[ebayCreateListing] Final ASIN: ${asin || "NONE"}`);

  // ⚠️ SKU決定: ASINがあれば常にSKU = ASIN（シンプル）
  if (asin) {
    sku = asin;
    debugLog(`[ebayCreateListing] SKU set to ASIN: ${sku}`);
  } else if (!sku) {
    debugLog(`[ebayCreateListing] ERROR: No ASIN and no SKU provided`);
    return {
      success: false,
      error: "出品中止: ASINが取得できませんでした。asinまたはamazon_urlパラメータを指定してください。",
      reason: "missing_asin",
    };
  }

  debugLog(`[ebayCreateListing] Final SKU: ${sku}`)

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
    manufacturer: string | null;
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
        manufacturer: keepaCheck.manufacturer,
        model: keepaCheck.model,
        price_jpy: keepaCheck.price_jpy,
        stock_count: keepaCheck.stock_count,
        shipping_days_min: keepaCheck.shipping_days_min,
        shipping_days_max: keepaCheck.shipping_days_max,
        is_prime: keepaCheck.is_prime,
        image_url: keepaCheck.image_url,
        status: keepaCheck.status,
      };

      // 在庫チェック（在庫切れのみブロック）
      // stock_count: null=データなし, -1=在庫あり(数量不明), 0=在庫切れ, 1+=在庫数
      if (keepaCheck.stock_count === 0) {
        debugLog(`[ebayCreateListing] BLOCKED: Out of stock (stock_count: 0)`);
        return {
          success: false,
          error: "出品中止: 在庫切れです（stock_count: 0）",
          reason: "out_of_stock",
          asin: asin,
          stock_count: 0,
        };
      }

      // 価格チェック
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

  // ============================================
  // カテゴリ自動判定（product_categoryが'default'の場合のみ）
  // ============================================
  if (product_category === "default" && keepaData) {
    const autoCategory = estimateProductCategory(
      keepaData.title || title,
      keepaData.title || "",  // Keepaのカテゴリ情報がない場合はタイトルを使用
      keepaData.brand || ""
    );
    product_category = autoCategory;
    debugLog(`[ebayCreateListing] Auto-detected product_category: ${product_category} (from title/brand)`);
  } else {
    debugLog(`[ebayCreateListing] Using provided product_category: ${product_category}`);
  }

  // Aspects（Item Specifics）の整形
  // eBayは1値あたり65文字制限。カンマ区切りの値は配列に分割する
  const EBAY_ASPECT_VALUE_MAX_LENGTH = 65;
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(item_specifics)) {
    if (!value) continue;
    const strValue = String(value);
    if (strValue.includes(",") || strValue.length > EBAY_ASPECT_VALUE_MAX_LENGTH) {
      // カンマ区切りで分割し、各値をトリムして65文字以内に切り詰め
      aspects[key] = strValue.split(",").map(v => v.trim()).filter(v => v.length > 0)
        .map(v => v.substring(0, EBAY_ASPECT_VALUE_MAX_LENGTH));
    } else {
      aspects[key] = [strValue];
    }
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

  // ストアカテゴリの自動付与（メーカー名で照合）
  const storeCategoryMapStr = process.env.STORE_CATEGORY_MAP;
  if (storeCategoryMapStr && keepaData?.manufacturer) {
    try {
      const storeCategoryMap: Record<string, string> = JSON.parse(storeCategoryMapStr);
      const manufacturer = keepaData.manufacturer.toLowerCase();
      for (const [key, categoryPath] of Object.entries(storeCategoryMap)) {
        if (manufacturer.includes(key.toLowerCase())) {
          offerData.storeCategoryNames = [categoryPath];
          debugLog(`[ebayCreateListing] Store category matched: manufacturer="${keepaData.manufacturer}" → "${categoryPath}"`);
          break;
        }
      }
      if (!offerData.storeCategoryNames) {
        debugLog(`[ebayCreateListing] No store category match for manufacturer="${keepaData.manufacturer}"`);
      }
    } catch (e) {
      debugLog(`[ebayCreateListing] WARNING: Failed to parse STORE_CATEGORY_MAP: ${e}`);
    }
  }

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
    // Brand/Model: Keepa優先 → item_specificsからフォールバック
    const brandForMonitor = keepaData?.brand
      || (item_specifics as Record<string, string>)?.["Brand"]
      || undefined;
    const modelForMonitor = keepaData?.model
      || (item_specifics as Record<string, string>)?.["Model"]
      || (item_specifics as Record<string, string>)?.["Reference Number"]
      || undefined;

    monitorResult = await registerToMonitor({
      asin,
      sku,
      ebay_item_id: listingId,
      // Keepaタイトル（日本語）を優先、なければeBayタイトル
      product_name: keepaData?.title || title,
      brand: brandForMonitor,
      model_number: modelForMonitor,
      ebay_price_usd: price_usd,
      // Keepa価格を優先、なければ入力値
      current_price_jpy: keepaData?.price_jpy ?? current_price_jpy,
      weight_g: weight_kg ? Math.round(weight_kg * 1000) : undefined,
      size_category,
      product_category,  // DDP関税率決定用カテゴリ
      length_cm,
      width_cm,
      height_cm,
      // Keepaデータ（last_checked_atを設定するために必要）
      // null値もそのまま送信（null ?? undefinedだとJSONから除外されてしまう）
      ...(keepaData ? {
        stock_count: keepaData.stock_count,
        shipping_days_min: keepaData.shipping_days_min,
        shipping_days_max: keepaData.shipping_days_max,
        is_prime: keepaData.is_prime,
        image_url: keepaData.image_url,
        status: keepaData.status ?? "正常",
      } : {
        status: "正常",
      }),
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
    target_profit_rate,
  } = params;

  // 入力値バリデーション
  if (!Number.isFinite(purchase_price_jpy) || purchase_price_jpy <= 0) {
    throw new Error(`無効な仕入れ価格です（purchase_price_jpy: ${purchase_price_jpy}）`);
  }
  if (!Number.isFinite(weight_g) || weight_g <= 0) {
    throw new Error(`無効な重量です（weight_g: ${weight_g}）`);
  }

  // Monitor APIに価格計算を委譲（動的粗利率を適用）
  // Monitor API未設定時はローカルフォールバック
  if (MONITOR_API_URL && MONITOR_API_KEY) {
    try {
      const url = `${MONITOR_API_URL}/api/calculate_selling_price.php`;
      const requestBody = {
        purchase_price_jpy,
        weight_g,
        size_category,
        product_category: category,
        purchase_quantity: 1,
      };

      // target_profit_rateが指定されている場合は固定粗利率、指定されていない場合は動的粗利率
      if (target_profit_rate !== undefined) {
        (requestBody as any).target_profit_rate = target_profit_rate * 100; // 0.15 → 15
      }

      debugLog(`[calculatePrice] Calling Monitor API: ${url}`);
      debugLog(`[calculatePrice] Request: ${JSON.stringify(requestBody)}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": MONITOR_API_KEY,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Monitor API error: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;
      debugLog(`[calculatePrice] Response: ${JSON.stringify(result)}`);

      if (!result.success || !result.selling_price_usd) {
        throw new Error(`Monitor API returned error: ${result.error || "Unknown error"}`);
      }

      // Monitor APIのレスポンスをMCP Serverのフォーマットに変換
      const breakdown = result.breakdown || {};
      return {
        selling_price_usd: result.selling_price_usd,
        shipping_jpy: breakdown.shippingJpy || 0,
        ddp_jpy: breakdown.ddpCostJpy || 0,
        customs_fee_jpy: breakdown.customsFeeJpy || 0,
        total_cost_jpy: breakdown.totalCostJpy || 0,
        estimated_profit_jpy: result.expected_profit_jpy || 0,
        profit_rate: result.expected_profit_rate || 0,
        exchange_rate: breakdown.exchangeRate || 0,
        effective_rate: (breakdown.exchangeRate || 0) * PAYONEER_EFFECTIVE_RATE,
        ebay_fees_usd: breakdown.ebayFeeUsd || 0,
      };
    } catch (error: any) {
      debugLog(`[calculatePrice] Monitor API failed, falling back to local calculation: ${error.message}`);
    }
  }

  // ローカルフォールバック計算（Monitor API未設定 or 障害時）
  debugLog(`[calculatePrice] Using local fallback calculation`);
  const profitRate = target_profit_rate ?? 0.15; // デフォルト15%
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const exchangeRate = await getExchangeRate();
  const effectiveRate = exchangeRate * PAYONEER_EFFECTIVE_RATE;
  const shippingJpy = getSpeedpakRate(destination, size_category, weight_g);
  const dutyRate = DDP_DUTY_RATES[category.toLowerCase()] || DDP_DUTY_RATES.default;

  // 目標粗利率から販売価格を逆算
  // 手取JPY = selling_price_usd * (1 - ebayFeeRate) * effectiveRate
  // 粗利JPY = 手取JPY - 総コストJPY
  // 粗利率 = 粗利JPY / 手取JPY = profitRate
  // → 手取JPY = 総コストJPY / (1 - profitRate)
  // → selling_price_usd = 手取JPY / ((1 - ebayFeeRate) * effectiveRate)
  const totalFixedCostJpy = purchase_price_jpy + shippingJpy + CUSTOMS_CLEARANCE_FEE_JPY;

  // eBay手数料率の近似値（iterativeに正確化）
  const approxFeeRate = category.toLowerCase() === "watches" ? 0.15 : 0.136;
  const salesTaxMultiplier = 1 + US_SALES_TAX_RATE;
  const totalFeeRate = (approxFeeRate + EBAY_INTL_FEE_RATE) * salesTaxMultiplier * (1 + EBAY_TAX_ON_FEES_RATE);

  // 初期推定価格
  const targetNetJpy = totalFixedCostJpy / (1 - profitRate);
  let sellingPriceUsd = round2(targetNetJpy / ((1 - totalFeeRate) * effectiveRate));

  // DDP関税を含めた再計算（1回のイテレーションで十分な精度）
  const dutyUsd = round2(sellingPriceUsd * dutyRate);
  const ddpProcessingUsd = round2(dutyUsd * DDP_PROCESSING_FEE_RATE);
  const ddpJpy = Math.round((dutyUsd + ddpProcessingUsd) * effectiveRate);
  const totalCostJpy = Math.round(totalFixedCostJpy + ddpJpy);
  const targetNetJpyWithDdp = totalCostJpy / (1 - profitRate);
  sellingPriceUsd = round2(targetNetJpyWithDdp / ((1 - totalFeeRate) * effectiveRate));

  // 実際のeBay手数料を計算
  const feeBase = round2(sellingPriceUsd * salesTaxMultiplier);
  const fvf = round2(calculateGraduatedFvf(feeBase, category));
  const perOrderFee = feeBase > 10 ? EBAY_PER_ORDER_FEE_HIGH : EBAY_PER_ORDER_FEE_LOW;
  const intlFee = round2(feeBase * EBAY_INTL_FEE_RATE);
  const feeSubtotal = round2(fvf + intlFee + perOrderFee);
  const taxOnFees = round2(feeSubtotal * EBAY_TAX_ON_FEES_RATE);
  const ebayFeesUsd = round2(feeSubtotal + taxOnFees);
  const netRevenueUsd = round2(sellingPriceUsd - ebayFeesUsd);
  const actualNetJpy = Math.round(netRevenueUsd * effectiveRate);
  const estimatedProfitJpy = actualNetJpy - totalCostJpy;
  const actualProfitRate = actualNetJpy > 0 ? Math.round((estimatedProfitJpy / actualNetJpy) * 1000) / 10 : 0;

  return {
    selling_price_usd: sellingPriceUsd,
    shipping_jpy: shippingJpy,
    ddp_jpy: ddpJpy,
    customs_fee_jpy: CUSTOMS_CLEARANCE_FEE_JPY,
    total_cost_jpy: totalCostJpy,
    estimated_profit_jpy: estimatedProfitJpy,
    profit_rate: actualProfitRate,
    exchange_rate: exchangeRate,
    effective_rate: effectiveRate,
    ebay_fees_usd: ebayFeesUsd,
    fallback: true, // ローカル計算であることを示す
  };
}

/**
 * 段階制FVF計算（カテゴリ別）
 */
function calculateGraduatedFvf(feeBase: number, category: string): number {
  const cat = category.toLowerCase();
  if (cat === "watches" || cat === "jewelry") {
    if (feeBase <= 1000) return feeBase * EBAY_FVF_RATE_WATCHES_T1;
    if (feeBase <= 7500) return 1000 * EBAY_FVF_RATE_WATCHES_T1
                              + (feeBase - 1000) * EBAY_FVF_RATE_WATCHES_T2;
    return 1000 * EBAY_FVF_RATE_WATCHES_T1
         + 6500 * EBAY_FVF_RATE_WATCHES_T2
         + (feeBase - 7500) * EBAY_FVF_RATE_WATCHES_T3;
  }
  return feeBase * EBAY_FVF_RATE_DEFAULT;
}

/**
 * 粗利シミュレーション（出品せずに粗利を計算）
 * Amazon商品のASINと販売予定価格を入力すると、粗利計算結果を返す（リサーチ用）
 */
async function estimateProfit(params: {
  asin_or_url: string;
  selling_price_usd: number;
  product_category?: string;
}) {
  const { asin_or_url, selling_price_usd, product_category = "default" } = params;

  // ASINを抽出
  const asin = extractAsin(asin_or_url);
  if (!asin) {
    return { error: "ASINを抽出できませんでした" };
  }

  // Keepaから商品情報を取得
  const keepaData = await keepaGetProduct(asin);
  if (!keepaData || !keepaData.price_jpy || !keepaData.weight_g) {
    return {
      error: "Keepaから商品情報を取得できませんでした",
      details: "価格または重量データが不足しています",
    };
  }

  // 梱包重量を推定（ebay-shipping-estimatorと同じロジック）
  const packagingWeight = estimatePackagingWeight(keepaData.title || "", keepaData.category || "");
  const shippingWeight = keepaData.package_weight_g > 0
    ? keepaData.package_weight_g + packagingWeight
    : keepaData.weight_g + packagingWeight;

  // サイズカテゴリを判定
  const totalDimension = (keepaData.package_length_mm || 0) +
                         (keepaData.package_width_mm || 0) +
                         (keepaData.package_height_mm || 0);
  let sizeCategory = "StandardB";
  if (totalDimension <= 600 && shippingWeight <= 500) {
    sizeCategory = "StandardA";
  } else if (totalDimension <= 600 && shippingWeight <= 2000) {
    sizeCategory = "StandardB";
  } else if (totalDimension <= 900 && shippingWeight <= 5000) {
    sizeCategory = "LargeA";
  } else {
    sizeCategory = "LargeB";
  }

  // 為替レート取得
  const exchangeRate = await getExchangeRate();
  const effectiveRate = exchangeRate * PAYONEER_EFFECTIVE_RATE;

  // 送料計算
  const shippingJpy = getSpeedpakRate("US", sizeCategory, shippingWeight);

  // DDP関税計算（各ステップで丸めて浮動小数点誤差を防止）
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const dutyRate = DDP_DUTY_RATES[product_category.toLowerCase()] || DDP_DUTY_RATES.default;
  const dutyUsd = round2(selling_price_usd * dutyRate);
  const ddpProcessingUsd = round2(dutyUsd * DDP_PROCESSING_FEE_RATE);
  const ddpJpy = Math.round((dutyUsd + ddpProcessingUsd) * effectiveRate);

  // eBay手数料計算（課金ベース = 販売価格 × 1.07 Sales Tax込み）
  const feeBase = round2(selling_price_usd * (1 + US_SALES_TAX_RATE));
  const fvf = round2(calculateGraduatedFvf(feeBase, product_category));
  const perOrderFee = feeBase > 10 ? EBAY_PER_ORDER_FEE_HIGH : EBAY_PER_ORDER_FEE_LOW;
  const intlFee = round2(feeBase * EBAY_INTL_FEE_RATE);
  const feeSubtotal = round2(fvf + intlFee + perOrderFee);
  const taxOnFees = round2(feeSubtotal * EBAY_TAX_ON_FEES_RATE);
  const ebayFeesUsd = round2(feeSubtotal + taxOnFees);

  // 手取り（Payoneer決済手数料なし、FXマークアップのみ）
  const netRevenueUsd = round2(selling_price_usd - ebayFeesUsd);
  const actualNetJpy = Math.round(netRevenueUsd * effectiveRate);

  // 総コスト（Sales Taxはコストではない：eBayがバイヤーから徴収→州に納付）
  const totalCostJpy = Math.round(keepaData.price_jpy + shippingJpy + ddpJpy + CUSTOMS_CLEARANCE_FEE_JPY);

  // 粗利
  const profitJpy = actualNetJpy - totalCostJpy;
  const profitRate = actualNetJpy > 0 ? (profitJpy / actualNetJpy) * 100 : 0;

  // SpeedPAK Economy制限チェック
  const withinLimit = selling_price_usd < 800;

  return {
    asin,
    product_name: keepaData.title,
    brand: keepaData.brand,
    // 入力値
    selling_price_usd,
    product_category,
    // 商品情報
    purchase_price_jpy: keepaData.price_jpy,
    shipping_weight_g: shippingWeight,
    size_category: sizeCategory,
    // 粗利計算結果
    profit_jpy: Math.round(profitJpy),
    profit_rate: Math.round(profitRate * 10) / 10,
    // 詳細内訳
    breakdown: {
      revenue_usd: selling_price_usd,
      fee_base_usd: Math.round(feeBase * 100) / 100,
      ebay_fvf_usd: Math.round(fvf * 100) / 100,
      ebay_fees_usd: Math.round(ebayFeesUsd * 100) / 100,
      tax_on_fees_usd: Math.round(taxOnFees * 100) / 100,
      net_revenue_usd: Math.round(netRevenueUsd * 100) / 100,
      net_revenue_jpy: Math.round(actualNetJpy),
      purchase_price_jpy: keepaData.price_jpy,
      shipping_jpy: shippingJpy,
      ddp_jpy: Math.round(ddpJpy),
      customs_fee_jpy: CUSTOMS_CLEARANCE_FEE_JPY,
      total_cost_jpy: Math.round(totalCostJpy),
    },
    exchange_rate: exchangeRate,
    effective_rate: effectiveRate,
    // SpeedPAK制限チェック
    speedpak_economy_ok: withinLimit,
    warning: !withinLimit ? "⚠️ $800以上のためSpeedPAK Economyは使用できません" : undefined,
  };
}

/**
 * 梱包重量推定ロジック（タイトル・カテゴリから判定）
 */
function estimatePackagingWeight(title: string, category: string): number {
  const text = (title + " " + category).toLowerCase();

  if (text.includes("ceramic") || text.includes("porcelain") ||
      text.includes("pottery") || text.includes("陶器") || text.includes("磁器")) {
    return 350; // 厳重梱包
  }
  if (text.includes("glass") || text.includes("ガラス")) {
    return 400; // 厳重梱包
  }
  if (text.includes("ironware") || text.includes("cast iron") ||
      text.includes("鉄器") || text.includes("鋳物")) {
    return 180; // 標準梱包（金属で重い）
  }
  if (text.includes("electronics") || text.includes("electronic") || text.includes("電子")) {
    return 150; // 標準梱包
  }
  if (text.includes("kitchen") || text.includes("キッチン") ||
      text.includes("plastic") || text.includes("プラスチック")) {
    return 150; // 標準梱包
  }
  if (text.includes("tool") || text.includes("metal") ||
      text.includes("工具") || text.includes("金属")) {
    return 80; // 軽量梱包
  }
  if (text.includes("clothing") || text.includes("fabric") ||
      text.includes("衣類") || text.includes("布")) {
    return 40; // 軽量梱包
  }

  return 150; // デフォルト（標準梱包）
}

/**
 * 商品カテゴリ自動判定ロジック（タイトル・カテゴリ・ブランドから判定）
 * DDP関税率決定用のカテゴリを推定
 */
function estimateProductCategory(title: string, category: string, brand: string = ""): string {
  const text = (title + " " + category + " " + brand).toLowerCase();

  // watches（腕時計）: 9%関税
  if (text.includes("watch") || text.includes("腕時計") || text.includes("ウォッチ") ||
      text.includes("g-shock") || text.includes("ジーショック") || text.includes("gショック") ||
      text.includes("seiko") || text.includes("セイコー") ||
      text.includes("citizen") || text.includes("シチズン") ||
      text.includes("casio") && (text.includes("watch") || text.includes("時計")) ||
      text.includes("chronograph") || text.includes("クロノグラフ") ||
      text.includes("automatic watch") || text.includes("自動巻") ||
      text.includes("wristwatch")) {
    return "watches";
  }

  // electronics（電子機器）: 0%関税（ITA対象品）
  // ⚠️ 腕時計を除外するため、watchesチェックの後に配置
  if (text.includes("electronics") || text.includes("電子機器") ||
      text.includes("headphone") || text.includes("earphone") || text.includes("イヤホン") ||
      text.includes("speaker") || text.includes("スピーカー") ||
      text.includes("camera") || text.includes("カメラ") ||
      text.includes("drone") || text.includes("ドローン") ||
      text.includes("tablet") || text.includes("タブレット") ||
      text.includes("laptop") || text.includes("ノートpc") ||
      text.includes("monitor") || text.includes("モニター") ||
      text.includes("keyboard") || text.includes("キーボード") ||
      text.includes("mouse") || text.includes("マウス")) {
    return "electronics";
  }

  // toys（おもちゃ）: 15%関税
  if (text.includes("toy") || text.includes("おもちゃ") || text.includes("トイ") ||
      text.includes("figure") || text.includes("フィギュア") ||
      text.includes("doll") || text.includes("人形") || text.includes("ドール") ||
      text.includes("plush") || text.includes("ぬいぐるみ") ||
      text.includes("lego") || text.includes("レゴ") ||
      text.includes("model kit") || text.includes("プラモデル")) {
    return "toys";
  }

  // clothing（衣類）: 16%関税
  if (text.includes("clothing") || text.includes("apparel") || text.includes("衣類") ||
      text.includes("shirt") || text.includes("シャツ") ||
      text.includes("pants") || text.includes("パンツ") ||
      text.includes("jacket") || text.includes("ジャケット") ||
      text.includes("coat") || text.includes("コート") ||
      text.includes("dress") || text.includes("ドレス") ||
      text.includes("skirt") || text.includes("スカート")) {
    return "clothing";
  }

  // cosmetics（化粧品）: 15%関税
  if (text.includes("cosmetic") || text.includes("化粧品") || text.includes("コスメ") ||
      text.includes("skincare") || text.includes("スキンケア") ||
      text.includes("makeup") || text.includes("メイク") ||
      text.includes("cream") || text.includes("クリーム") ||
      text.includes("serum") || text.includes("美容液") ||
      text.includes("lotion") || text.includes("化粧水") ||
      text.includes("mask") || text.includes("マスク") || text.includes("パック")) {
    return "cosmetics";
  }

  // jewelry（ジュエリー）: 15%関税
  // ⚠️ 腕時計を除外
  if ((text.includes("jewelry") || text.includes("jewellery") || text.includes("ジュエリー") ||
       text.includes("necklace") || text.includes("ネックレス") ||
       text.includes("bracelet") || text.includes("ブレスレット") ||
       text.includes("ring") || text.includes("指輪") || text.includes("リング") ||
       text.includes("earring") || text.includes("イヤリング") || text.includes("ピアス")) &&
      !text.includes("watch") && !text.includes("時計")) {
    return "jewelry";
  }

  // tools（工具）: 15%関税
  if (text.includes("tool") || text.includes("工具") ||
      text.includes("drill") || text.includes("ドリル") ||
      text.includes("wrench") || text.includes("レンチ") ||
      text.includes("hammer") || text.includes("ハンマー") ||
      text.includes("saw") || text.includes("のこぎり")) {
    return "tools";
  }

  // food（食品）: 15%関税
  if (text.includes("food") || text.includes("食品") ||
      text.includes("snack") || text.includes("スナック") ||
      text.includes("tea") || text.includes("お茶") ||
      text.includes("coffee") || text.includes("コーヒー") ||
      text.includes("seasoning") || text.includes("調味料") ||
      text.includes("supplement") || text.includes("サプリ")) {
    return "food";
  }

  return "default"; // デフォルト: 15%関税
}

/**
 * ディスクリプション生成用の構造化データ取得
 * 実際の英語ディスクリプション生成はClaude側で行う（CLAUDE.mdのテンプレートに従う）
 */
async function generateDescription(params: {
  asin_or_url: string;
  category?: string;
}) {
  const { asin_or_url, category } = params;

  // ASINを抽出
  const asin = extractAsin(asin_or_url);
  if (!asin) {
    return { error: "ASINを抽出できませんでした" };
  }

  // Keepaから商品情報を取得
  const keepaData = await keepaGetProduct(asin);
  if (!keepaData || !keepaData.title) {
    return { error: "商品情報の取得に失敗しました" };
  }

  // カテゴリ自動判定
  const productCategory = category || estimateProductCategory(
    keepaData.title,
    keepaData.category || "",
    keepaData.brand || ""
  );

  // 梱包重量推定
  const packagingWeight = estimatePackagingWeight(
    keepaData.title || "",
    keepaData.category || ""
  );
  const shippingWeight = keepaData.package_weight_g > 0
    ? keepaData.package_weight_g + packagingWeight
    : keepaData.weight_g + packagingWeight;

  // サイズカテゴリ判定
  const totalDimension = (keepaData.package_length_mm || 0) +
                         (keepaData.package_width_mm || 0) +
                         (keepaData.package_height_mm || 0);
  let sizeCategory = "StandardB";
  if (totalDimension <= 600 && shippingWeight <= 500) {
    sizeCategory = "StandardA";
  } else if (totalDimension <= 600 && shippingWeight <= 2000) {
    sizeCategory = "StandardB";
  } else if (totalDimension <= 900 && shippingWeight <= 5000) {
    sizeCategory = "LargeA";
  } else {
    sizeCategory = "LargeB";
  }

  // 構造化データを返す（英語ディスクリプションはClaude側で生成）
  const result: any = {
    asin,
    title_ja: keepaData.title,
    brand: keepaData.brand,
    manufacturer: keepaData.manufacturer,
    model: keepaData.model,
    category: productCategory,
    features: keepaData.features || [],
    description: keepaData.description || "",
    images: keepaData.images || [],
    // 商品仕様
    weight_g: keepaData.weight_g,
    package_weight_g: keepaData.package_weight_g,
    shipping_weight_g: shippingWeight,
    package_length_mm: keepaData.package_length_mm,
    package_width_mm: keepaData.package_width_mm,
    package_height_mm: keepaData.package_height_mm,
    size_category: sizeCategory,
    // Keepa追加属性
    color: keepaData.color,
    size: keepaData.size,
    materials: keepaData.materials,
    country_of_origin: keepaData.countryOfOrigin,
    // 価格・在庫情報
    price_jpy: keepaData.price_jpy,
    stock_available: keepaData.stock_available,
    stock_count: keepaData.stock_count,
    is_prime: keepaData.is_prime,
    shipping_days_max: keepaData.shipping_days_max,
    status: keepaData.status,
  };

  // 腕時計の場合: Item Specificsを指定順序で構築
  if (productCategory === "watches") {
    result.watch_item_specifics = buildWatchItemSpecifics(keepaData);
  }

  return result;
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
    name: "estimate_profit",
    description: "出品せずに粗利をシミュレーション（リサーチ用）。Amazon URLと販売予定価格を入力すると、粗利計算結果を返します。Keepaから商品情報を取得し、実際の手数料・送料・関税を考慮した正確な粗利を計算します。",
    inputSchema: {
      type: "object",
      properties: {
        asin_or_url: {
          type: "string",
          description: "Amazon URLまたはASIN（例: B0171RU9NW または https://www.amazon.co.jp/dp/B0171RU9NW）",
        },
        selling_price_usd: {
          type: "number",
          description: "販売予定価格（USD、例: 250.00）",
        },
        product_category: {
          type: "string",
          description: "商品カテゴリ（DDP関税率決定用: watches=9%, electronics=0%, default=15%等、デフォルト: default）",
        },
      },
      required: ["asin_or_url", "selling_price_usd"],
    },
  },
  {
    name: "generate_description",
    description: "Amazon商品のASINから構造化された商品データを取得します。Keepaから商品情報（タイトル、ブランド、特徴、画像、サイズ等）を取得し、カテゴリを自動判定します。実際の英語ディスクリプション生成はClaude側で行います（CLAUDE.mdのテンプレートに従う）。",
    inputSchema: {
      type: "object",
      properties: {
        asin_or_url: {
          type: "string",
          description: "Amazon URLまたはASIN（例: B0171RU9NW または https://www.amazon.co.jp/dp/B0171RU9NW）",
        },
        category: {
          type: "string",
          description: "商品カテゴリ（watches/electronics/food/cosmetics等、未指定時は自動判定）",
        },
      },
      required: ["asin_or_url"],
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
          description: "商品SKU（オプショナル。未指定時はMonitor APIから自動発行、例: A1B2C3D4）",
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
        product_category: {
          type: "string",
          description: "商品カテゴリ（DDP関税率決定用: watches=9%, electronics=0%, default=15%等、Monitor連携用）",
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

      case "estimate_profit":
        result = await estimateProfit(args as any);
        break;

      case "generate_description":
        result = await generateDescription(args as any);
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
