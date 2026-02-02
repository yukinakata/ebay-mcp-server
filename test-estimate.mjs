#!/usr/bin/env node
/**
 * 見積もりテストスクリプト
 * 使用方法: node test-estimate.mjs
 */

import * as dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ===========================================
// 定数（ebay-profit-calculator準拠）
// ===========================================
const EBAY_FVF_RATE = 0.127;         // 2025年 eBay Final Value Fee
const EBAY_INTL_FEE_RATE = 0.0135;   // 2025年 International Fee
const EBAY_PER_ORDER_FEE_HIGH = 0.40; // $10超の場合
const EBAY_PER_ORDER_FEE_LOW = 0.30;  // $10以下の場合
const PAYONEER_FEE_RATE = 0.02;       // Payoneer手数料 2%
const PAYONEER_HIDDEN_COST = 0.02;    // 為替スプレッド（隠しコスト） 2%

// DDP関税率（2025-2026年 実効税率 = MAX(MFN税率, 相互関税15%)）
// 日本からの輸入品に対する相互関税15%を考慮
const DDP_DUTY_RATES = {
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

const SPEEDPAK_RATES = {
  US: {
    StandardA: { 500: 1367, 1000: 1724, 1500: 2081, 2000: 2303 },
    StandardB: { 500: 1659, 1000: 2017, 1500: 2374, 2000: 2587 },
    LargeA: { 1000: 2710, 2000: 3425, 3000: 4140, 4000: 4855, 5000: 5570 },
    LargeB: { 2000: 3790, 4000: 5220, 6000: 6650, 8000: 8080, 10000: 9510 },
  },
};

// ===========================================
// ヘルパー関数
// ===========================================
function extractAsin(urlOrAsin) {
  if (/^[A-Z0-9]{10}$/i.test(urlOrAsin)) {
    return urlOrAsin.toUpperCase();
  }
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /asin=([A-Z0-9]{10})/i,
  ];
  for (const pattern of patterns) {
    const match = urlOrAsin.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function getSpeedpakRate(sizeCategory, weightG) {
  const rates = SPEEDPAK_RATES.US[sizeCategory] || SPEEDPAK_RATES.US.StandardA;
  const sortedWeights = Object.keys(rates).map(Number).sort((a, b) => a - b);
  for (const maxWeight of sortedWeights) {
    if (weightG <= maxWeight) return rates[maxWeight];
  }
  return rates[sortedWeights[sortedWeights.length - 1]];
}

async function getExchangeRate() {
  try {
    const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=JPY");
    const data = await response.json();
    return data.rates.JPY;
  } catch {
    return 155.0;
  }
}

// ===========================================
// Keepa API
// ===========================================
async function keepaGetProduct(asin) {
  const apiKey = process.env.KEEPA_API_KEY;
  if (!apiKey) throw new Error("KEEPA_API_KEY が設定されていません");

  const url = `https://api.keepa.com/product?key=${apiKey}&domain=5&asin=${asin}&history=1&offers=20&stats=1`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) throw new Error(`Keepa API エラー: ${JSON.stringify(data.error)}`);
  if (!data.products || data.products.length === 0) throw new Error(`商品が見つかりません: ${asin}`);

  const product = data.products[0];

  // 価格取得
  let priceJpy = null;
  const stats = product.stats || {};
  const current = stats.current || [];
  if (current[0] && current[0] > 0) priceJpy = current[0];
  else if (current[1] && current[1] > 0) priceJpy = current[1];

  // 画像URL
  const images = [];
  if (product.imagesCSV) {
    const codes = product.imagesCSV.split(",").slice(0, 5);
    for (const code of codes) {
      images.push(`https://images-na.ssl-images-amazon.com/images/I/${code}`);
    }
  }

  return {
    asin: product.asin,
    title: product.title,
    price_jpy: priceJpy,
    brand: product.brand,
    manufacturer: product.manufacturer,
    category: product.categoryTree?.slice(-1)[0]?.name || null,
    weight_g: product.itemWeight || null,
    package_weight_g: product.packageWeight || null,
    package_length_mm: product.packageLength || null,
    package_width_mm: product.packageWidth || null,
    package_height_mm: product.packageHeight || null,
    features: product.features || [],
    images,
  };
}

// ===========================================
// 価格計算
// ===========================================
async function calculatePrice(purchasePriceJpy, weightG, sizeCategory, category = "default", targetProfitRate = 0.15) {
  const exchangeRate = await getExchangeRate();
  const shippingJpy = getSpeedpakRate(sizeCategory, weightG);
  const effectiveRate = exchangeRate * (1 - PAYONEER_HIDDEN_COST); // 為替スプレッド2%を考慮
  const dutyRate = DDP_DUTY_RATES[category.toLowerCase()] || DDP_DUTY_RATES.default;
  const customsClearanceJpy = 245; // 通関手数料

  // 反復計算（Per-order fee と DDP費用の変動を考慮）
  let priceUsd = 50.0;
  for (let i = 0; i < 20; i++) {
    // Per-order feeは売価によって変動（$10以上で$0.40、$10以下で$0.30）
    const perOrderFee = priceUsd > 10 ? EBAY_PER_ORDER_FEE_HIGH : EBAY_PER_ORDER_FEE_LOW;

    // DDP費用（関税 + 2.1%処理手数料）
    const dutyUsd = priceUsd * dutyRate;
    const ddpProcessingUsd = dutyUsd * DDP_PROCESSING_FEE_RATE;
    const ddpTotalUsd = dutyUsd + ddpProcessingUsd;
    const ddpJpy = ddpTotalUsd * exchangeRate;

    // 総コスト（仕入 + 送料 + DDP + 通関手数料）
    const totalCostJpy = purchasePriceJpy + shippingJpy + ddpJpy + customsClearanceJpy;

    // 目標粗利率から必要な売上を逆算
    const requiredRevenueJpy = totalCostJpy / (1 - targetProfitRate);

    // Payoneer入金後の手取り（円）から、eBay手数料控除前の売価（USD）を逆算
    // requiredRevenueJpy = (priceUsd - eBayFees) × (1 - payoneerFeeRate) × effectiveRate
    // eBayFees = priceUsd × (FVF + INTL) + perOrderFee
    // requiredRevenueJpy = [priceUsd - priceUsd × (FVF + INTL) - perOrderFee] × (1 - payoneerFeeRate) × effectiveRate
    // requiredRevenueJpy = priceUsd × [1 - (FVF + INTL)] × (1 - payoneerFeeRate) × effectiveRate - perOrderFee × (1 - payoneerFeeRate) × effectiveRate
    // priceUsd = (requiredRevenueJpy + perOrderFee × (1 - payoneerFeeRate) × effectiveRate) / ([1 - (FVF + INTL)] × (1 - payoneerFeeRate) × effectiveRate)

    const payoneerNetRate = (1 - PAYONEER_FEE_RATE) * effectiveRate;
    const ebayNetRate = 1 - (EBAY_FVF_RATE + EBAY_INTL_FEE_RATE);
    const newPriceUsd = (requiredRevenueJpy + perOrderFee * payoneerNetRate) / (ebayNetRate * payoneerNetRate);

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
  const netRevenueJpy = netRevenueUsd * effectiveRate;

  const ddpFinalUsd = finalPriceUsd * dutyRate * (1 + DDP_PROCESSING_FEE_RATE);
  const ddpFinalJpy = ddpFinalUsd * exchangeRate;

  const totalCostFinalJpy = purchasePriceJpy + shippingJpy + ddpFinalJpy + customsClearanceJpy;
  const profitJpy = netRevenueJpy - totalCostFinalJpy;
  const profitRate = netRevenueJpy > 0 ? profitJpy / netRevenueJpy : 0;

  return {
    selling_price_usd: finalPriceUsd,
    shipping_jpy: shippingJpy,
    ddp_jpy: Math.round(ddpFinalJpy),
    total_cost_jpy: Math.round(totalCostFinalJpy),
    estimated_profit_jpy: Math.round(profitJpy),
    profit_rate: Math.round(profitRate * 1000) / 1000,
    exchange_rate: exchangeRate,
  };
}

// ===========================================
// サイズカテゴリ判定
// ===========================================
function determineSizeCategory(lengthMm, widthMm, heightMm, weightG) {
  // mmをcmに変換
  const l = (lengthMm || 0) / 10;
  const w = (widthMm || 0) / 10;
  const h = (heightMm || 0) / 10;
  
  const maxDim = Math.max(l, w, h);
  const sumDim = l + w + h;
  
  // StandardA: 最長辺60cm以内、3辺合計90cm以内、2kg以内
  if (maxDim <= 60 && sumDim <= 90 && weightG <= 2000) {
    return weightG <= 500 ? "StandardA" : "StandardB";
  }
  // LargeA/B
  if (weightG <= 5000) return "LargeA";
  return "LargeB";
}

// ===========================================
// メイン処理
// ===========================================
async function main() {
  const testUrl = "https://www.amazon.co.jp/dp/B002ZJXQ4G";
  
  console.log("=".repeat(60));
  console.log("📦 eBay見積もりテスト");
  console.log("=".repeat(60));
  
  // Step 1: ASIN抽出
  console.log("\n🔍 Step 1: ASIN抽出");
  const asin = extractAsin(testUrl);
  console.log(`   ASIN: ${asin}`);
  
  // Step 2: Keepa商品情報取得
  console.log("\n📊 Step 2: Keepa商品情報取得");
  const product = await keepaGetProduct(asin);
  console.log(`   タイトル: ${product.title}`);
  console.log(`   価格: ¥${product.price_jpy?.toLocaleString() || "不明"}`);
  console.log(`   ブランド: ${product.brand || "不明"}`);
  console.log(`   カテゴリ: ${product.category || "不明"}`);
  console.log(`   重量: ${product.weight_g || product.package_weight_g || "不明"}g`);
  console.log(`   サイズ: ${product.package_length_mm}x${product.package_width_mm}x${product.package_height_mm}mm`);
  console.log(`   画像数: ${product.images.length}枚`);
  
  // Step 3: サイズカテゴリ判定
  const weightG = product.weight_g || product.package_weight_g || 500;
  const sizeCategory = determineSizeCategory(
    product.package_length_mm,
    product.package_width_mm,
    product.package_height_mm,
    weightG
  );
  console.log(`\n📐 Step 3: サイズカテゴリ判定`);
  console.log(`   カテゴリ: ${sizeCategory}`);
  
  // Step 4: 価格計算
  if (product.price_jpy) {
    console.log("\n💰 Step 4: 価格計算（目標粗利15%）");
    const estimate = await calculatePrice(product.price_jpy, weightG, sizeCategory, "default", 0.15);
    
    console.log(`\n${"─".repeat(40)}`);
    console.log(`   📌 推奨販売価格: $${estimate.selling_price_usd.toFixed(2)}`);
    console.log(`   📦 送料（SpeedPAK）: ¥${estimate.shipping_jpy.toLocaleString()}`);
    console.log(`   🏛️ DDP関税: ¥${estimate.ddp_jpy.toLocaleString()}`);
    console.log(`   💵 総コスト: ¥${estimate.total_cost_jpy.toLocaleString()}`);
    console.log(`   📈 予想粗利: ¥${estimate.estimated_profit_jpy.toLocaleString()}`);
    console.log(`   📊 粗利率: ${(estimate.profit_rate * 100).toFixed(1)}%`);
    console.log(`   💱 為替レート: ¥${estimate.exchange_rate.toFixed(2)}/USD`);
    console.log(`${"─".repeat(40)}`);
  } else {
    console.log("\n⚠️ 価格情報が取得できませんでした");
  }
  
  console.log("\n✅ テスト完了！");
}

main().catch(console.error);
