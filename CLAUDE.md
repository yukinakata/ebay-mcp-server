# eBay MCP Server - 自動出品システム

## ⚠️ 絶対ルール

**Amazon URLまたはASINが入力されたら、質問・確認・選択肢の提示をせず、出品完了まで一気に自動実行すること。**

途中で止まらない。分析結果だけ表示して終わらない。yes/no確認も不要。**出品完了まで一気に進む。**

## 自動出品フロー（すべて自動実行）

### Step 0: トークンチェック（自動）

`keepa_get_product` 実行時に自動でトークン残量をチェック。
- 残り5トークン未満 → エラーメッセージで待機時間を表示
- 1分あたり約5トークン回復

### Step 1-2: 商品情報取得（自動）

```
1. ユーザー入力のAmazon URLからASINを抽出
2. keepa_get_product でASINから商品情報を取得
3. ⚠️ 抽出したASINを変数に保存し、Step 7で必ず使用すること

例:
const amazonUrl = "https://www.amazon.co.jp/dp/B0DVL6MXRX";  // ← ユーザー入力
const asinResult = await extract_asin(amazonUrl);
const asin = asinResult.asin;  // ← 重要: この変数をStep 7まで保持
const keepaData = await keepa_get_product(asin);

⚠️ 最重要:
- asin変数をStep 7のebay_create_listingに「asin」パラメータとして渡すこと
- ASINを渡さないと、ランダムなSKU（例: WS8M2EU7）が生成される
- ASINを渡すと、SKU = ASIN（例: B0DVL6MXRX）になる
```

### Step 3: カテゴリ選定（自動）

```
ebay_suggest_category → ebay_get_item_aspects
※英語タイトルで検索、best_matchを自動採用
```

### Step 3.5: 梱包重量推定（自動・重要）

```
Keepaのpackage_weight_gに梱包材重量を加算

梱包パターン判定（ebay-shipping-estimatorスキル準拠）:
1. プラスチック製品・金属製品・衣類 → 軽量梱包（+50〜100g）
2. 電子機器・キッチン用品・雑貨 → 標準梱包（+100〜200g）
3. 陶器・ガラス・精密機器 → 厳重梱包（+300〜500g）

判定基準:
- タイトル・カテゴリに「陶器」「ceramic」「glass」「porcelain」→ +300g
- タイトル・カテゴリに「electronics」「精密」→ +150g
- その他キッチン用品・雑貨 → +150g（デフォルト）
- 金属製品（ironware等） → +150g
- プラスチック製品 → +100g

発送重量 = package_weight_g + 梱包材重量
```

### Step 4: サイズカテゴリ判定（自動）

```
3辺合計とサイズから判定:
- 3辺合計 ≤ 60cm かつ 発送重量 ≤ 500g → StandardA
- 3辺合計 ≤ 60cm かつ 発送重量 ≤ 2000g → StandardB
- 3辺合計 ≤ 90cm かつ 発送重量 ≤ 5000g → LargeA
- 上記以外 → LargeB
```

### Step 5: 価格計算（自動・動的粗利率）

```
calculate_price（target_profit_rateは指定しない = 動的粗利率を使用）
※発送重量とサイズカテゴリを使用
※動的粗利率設定（設定画面で設定）に基づいて計算
※複数シナリオを表示しない。計算された価格のみ使用。
```

### Step 6: リスティング作成（自動）

```
タイトル: [Brand] [Product Type] [Model] + 日本製表記（80文字以内、必ず収まるように調整）
SKU: ASINと同じ値を使用（例: B0171RU9NW）
説明文: HTML形式で自動生成
  - カテゴリに応じた説明文テンプレートを使用
  - 食品・化粧品・サプリ・石鹸の場合：
    * Ingredientsセクションを必ず含める
    * 成分分析表リンクがあれば追加
    * Precautions・Disclaimer等の必須項目を記載
Item Specifics: ebay_get_item_aspectsの必須項目を埋める
  - Country of Origin: 以下のルールで設定
    * Amazonに原産国の記載がある場合 → その値を使用
    * Amazonに原産国の記載がなく、ムーブメントが日本製の場合 → Japan
    * 上記以外 → 未設定
```

#### タイトル生成の詳細ルール（80文字制限対応）

**重要: タイトルは必ず80文字以内に収め、途中で切れないようにする**

**タイトルから除外する文字列:**

以下の文字列はAmazonタイトルに含まれていても、eBayタイトルには含めない:
- 並行輸入品
- [並行輸入品]
- （並行輸入品）
- 国内正規品
- [国内正規品]
- （国内正規品）
- Parallel Import
- Grey Import
- Gray Import
- 正規輸入品
- 日本製（Made in Japanに置き換える）

**除外と置き換えの例:**
```
例1: Amazonタイトルに「日本製」がある場合
Amazon: ソニー ワイヤレスイヤホン WF-1000XM5 日本製 [並行輸入品]
eBay:   Sony Wireless Earbuds WF-1000XM5 Made in Japan

例2: Amazonタイトルに「国内正規品」がある場合
Amazon: ソニー ワイヤレスイヤホン WF-1000XM5 国内正規品
eBay:   Sony Wireless Earbuds WF-1000XM5 JAPAN

例3: Amazonタイトルに「並行輸入品」のみの場合
Amazon: ソニー ワイヤレスイヤホン WF-1000XM5 [並行輸入品]
eBay:   Sony Wireless Earbuds WF-1000XM5
       （何も追加しない）
```

**日本製表記の優先順位:**

⚠️ **重複回避ルール: 以下の優先順位で判定し、上位のルールが適用された場合は下位のルールを適用しない**

1. **Amazonタイトルに「日本製」が含まれる場合**（最優先）:
   ```
   「日本製」を削除 → Made in Japan を追加

   優先度1: Made in Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度2: Made Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度3: Japan を追加
   └─ 必ず80文字以内に収まるよう調整

   ※この場合、「国内正規品」「原産国」「ムーブメント」のルールは適用しない
   ```

2. **Amazonタイトルに「国内正規品」が含まれる場合**（「日本製」がない場合のみ）:
   ```
   「国内正規品」を削除 → JAPAN を追加
   └─ 必ず80文字以内に収まるよう調整

   ※この場合、「原産国」「ムーブメント」のルールは適用しない
   ```

3. **原産国が日本の場合（Keepaデータの Country of Origin）**（上記1, 2がない場合のみ）:
   ```
   優先度1: Made in Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度2: Made Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度3: Japan を追加
   └─ 必ず80文字以内に収まるよう調整

   ※この場合、「ムーブメント」のルールは適用しない
   ```

4. **ムーブメントが日本製の場合**（上記1, 2, 3がない場合のみ）:
   ```
   タイトルまたは説明文に以下のいずれかが含まれる場合:
   - 日本製ムーブメント
   - Japanese Movement
   - Japan Movement
   - Miyota Movement（ミヨタ = シチズン系の日本製ムーブメント）
   - Seiko Movement

   優先度1: Made in Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度2: Made Japan を追加
   ├─ 80文字以内に収まる → 使用
   └─ 80文字を超える → 次へ

   優先度3: Japan を追加
   └─ 必ず80文字以内に収まるよう調整
   ```

5. **上記のいずれにも該当しない場合**:
   ```
   日本製表記を追加しない
   ```

**調整方法:**
- タイトルが長すぎる場合は、不要な修飾語を削除
- 型番や詳細情報を優先し、説明的な単語を削る
- 最終的に必ず80文字ちょうどまたは以下に収める

**例:**
```
元: Sony Professional XYZ-123 High Quality Wireless Bluetooth Speaker System [Made in Japan/Made Japan/Japan]
長い: 82文字 → 超過

調整1: Sony XYZ-123 Professional Wireless Bluetooth Speaker System [Made in Japan/Made Japan/Japan]
→ 77文字 ✅

調整2（それでも長い場合）: Sony XYZ-123 Wireless Bluetooth Speaker System Made Japan
→ 68文字 ✅

調整3（さらに長い場合）: Sony XYZ-123 Wireless Bluetooth Speaker System Japan
→ 61文字 ✅
```

#### ディスクリプション生成の詳細ルール（日本製表記）

**⚠️ 重要: 製品全体がMade in Japanなのか、一部（ムーブメントなど）のみが日本製なのかを明確に区別すること**

**⚠️ タイトル生成ルールと連動: タイトルに日本製表記を追加した場合は、ディスクリプションにも必ず対応する記載を含めること**

トラブル回避のため、Amazonのディスクリプション（商品説明）を確実に読み取り、以下のルールに従ってeBayディスクリプションを生成する:

**1. 製品全体が日本製の場合:**

判定条件（タイトル生成ルール1, 3に対応）:
- Amazonタイトルに「日本製」が含まれる（タイトル生成ルール1に該当）
- OR: Keepaデータの Country of Origin が "Japan"（タイトル生成ルール3に該当）
- AND: ムーブメントのみが日本製という記載がない

eBayディスクリプションの記載（必須）:
```
✅ "Made in Japan" と必ず記載する

例1（基本）:
This product is made in Japan with superior quality and craftsmanship.

例2（詳細）:
Manufactured in Japan using traditional techniques and premium materials.
Proudly made in Japan, this product represents the highest standards of Japanese quality.

例3（商品カテゴリ別）:
- 陶磁器: Handcrafted in Japan by skilled artisans using centuries-old techniques.
- 包丁: Forged in Japan with traditional bladesmithing methods passed down through generations.
- 電子機器: Designed and manufactured in Japan with meticulous attention to detail.
- 食品: Produced in Japan using authentic Japanese ingredients and methods.
```

**2. ムーブメントのみが日本製の場合:**

判定条件（タイトル生成ルール4に対応）:
- タイトルまたは説明文に「日本製ムーブメント」「Japanese Movement」「Miyota Movement」「Seiko Movement」等が含まれる（タイトル生成ルール4に該当）
- AND: 製品全体の原産国が日本ではない、または不明
- OR: 明確に「ムーブメントのみ日本製」と記載されている

**Item Specifics の設定:**
- **Country of Origin: Japan**（Amazonに原産国の記載がない場合でも、ムーブメントが日本製ならJapanに設定）

eBayディスクリプションの記載（必須フォーマット）:
```
⚠️ ムーブメントのみが日本製であることを明確に記載する
⚠️ 製品全体が "Made in Japan" という誤解を与えないようにする

例1（腕時計の場合・基本フォーマット）:
Movement: Japanese Quartz (made in Japan)
Case/Band: Assembly country unknown

例2（詳細版）:
This watch features a high-quality Japanese-made movement for precise timekeeping.
• Movement: Miyota/Seiko Quartz (made in Japan)
• Case and band: Assembly country varies

例3（より詳しい場合）:
Movement: Japanese Quartz movement (Miyota/Seiko, made in Japan)
Case: Stainless steel (assembly country unknown)
Band: Leather/Metal (assembly country unknown)

例4（説明文に組み込む場合）:
Equipped with a reliable Japanese Quartz movement (Miyota, made in Japan),
this timepiece offers precision and durability. The case and band are assembled
using quality materials, with assembly country varying by production batch.
```

**3. 判定が不明確な場合:**
```
❌ "Made in Japan" を記載しない
✅ 確実な情報のみを記載する

例:
Manufactured with high-quality Japanese components.
Features Japanese craftsmanship and attention to detail.
```

**4. トラブル回避のための禁止事項:**
- 製品全体が日本製でない場合に "Made in Japan" と記載してはいけない
- ムーブメントのみが日本製の場合は、必ず部品レベル（"Movement only"）であることを明記する
- 曖昧な表現（"Japanese quality" だけ等）は避け、具体的に何が日本製なのかを明記する
- 不明確な記載はeBayポリシー違反やバイヤーからのクレームにつながるため、確実な情報のみを記載する

### Step 7: 出品実行（自動・確認不要）

```
ebay_get_policies → ebay_create_listing

⚠️ 最重要: Step 1-2で保存したasin変数を必ず指定すること
  （ASINを指定しないと、ランダムなSKUが生成され、監視システムに登録されない）

※ yes/no確認は不要。自動的に出品を実行する。
※ weight_kg = 発送重量（梱包込み）÷ 1000
※ length_cm, width_cm, height_cm = Keepaのパッケージサイズをcmに変換
```

**必須パラメータ:**
```javascript
ebay_create_listing({
  asin: asin,  // ← 必須！Step 1-2で保存したASIN変数を必ず渡す
  title: "...",
  description: "...",
  price_usd: 250.00,
  category_id: "...",
  images: [...],
  weight_kg: ...,
  length_cm: ...,
  width_cm: ...,
  height_cm: ...,
  current_price_jpy: keepaData.price_jpy,  // Keepaから取得した価格
  size_category: "StandardA",  // Step 4で判定したサイズ
  // その他のパラメータ
})
```

**重要:**
- `asin`パラメータは必須（SKU = ASINとなり、監視システムに登録される）
- `asin`を渡さないと、エラーまたはランダムなSKU（例: WS8M2EU7）が生成される
- Step 1-2で`keepa_get_product(asin)`に渡したASINと同じ値を使用すること
```

### Step 8: 出品完了表示

```
══════════════════════════════════════════════════════
　　　　　　　eBay出品完了
══════════════════════════════════════════════════════

【商品情報】
タイトル: [タイトル]
SKU: [SKU]
eBay URL: https://www.ebay.com/itm/[Listing ID]

【価格・利益】
販売価格: $XX.99
仕入れ価格: ¥X,XXX
予想粗利: ¥X,XXX (XX.X%)

【Monitor連携】
✓ 在庫監視システムに自動登録済み

══════════════════════════════════════════════════════
```

## 🚫 禁止事項

1. **価格シナリオを複数表示しない**（15%粗利のみ使用）
2. **「どの分析を行いますか？」と聞かない**
3. **「次のステップとして〜」と選択肢を出さない**
4. **途中で止まらない**（出品完了まで一気に進む）
5. **推奨価格の説明をしない**（$70〜$80がおすすめ、などは不要）
6. **yes/no確認を求めない**（自動的に出品を実行する）
7. **「出品を実行しますか？」と聞かない**
8. **人体に影響がある商品で成分表示を省略しない**（食品・化粧品・サプリ・石鹸等）

## ⚠️ 成分表示に関する重要事項

### 成分表示が必須の商品カテゴリ

以下のカテゴリは**必ず成分表示（Ingredients）を含める**こと：

| カテゴリ | 必須項目 | 追加推奨 |
|---------|---------|---------|
| **食品・飲料** | Ingredients、Allergen Info、Best Before | Nutrition Facts、Storage |
| **化粧品・スキンケア** | Ingredients (INCI)、Precautions、Volume | How to Use、Safety Data |
| **サプリメント** | Supplement Facts、Ingredients、Disclaimer | Warnings、GMP Certification |
| **石鹸・バス用品** | Ingredients、Precautions | How to Use、Net Weight |
| **ベビー用品（口に触れる）** | Ingredients、Safety Standards | Age Recommendation |

### 自動判定ルール

Keepaから取得した商品名・カテゴリに以下のキーワードが含まれる場合、**自動的に成分表示テンプレートを適用**：

```
食品: tea, coffee, seasoning, spice, snack, chocolate, candy, supplement
化粧品: cosmetic, skincare, cream, serum, lotion, essence, mask, facial
サプリ: supplement, vitamin, collagen, enzyme, extract, capsule, tablet
石鹸: soap, shampoo, conditioner, body wash, bath salt, cleansing
```

### 成分情報の取得方法

1. **Keepaの商品説明から抽出**（Amazon商品ページに記載されている場合）
2. **公式サイトへのリンクを記載**（成分分析表PDFなど）
3. **不明な場合**: 「Please refer to the product packaging for detailed ingredient information」と記載

### リンク記載の優先順位

成分分析表や公式情報へのリンクがある場合、以下の優先順位で記載：

1. 成分分析表PDF（最優先）
2. 公式商品ページ（日本語可）
3. メーカー公式サイト
4. Amazon商品ページ（参考情報として）

## デフォルト設定

| 設定       | 値     |
| ---------- | ------ |
| 目標粗利率 | 動的粗利率（設定画面で設定、デフォルト15%）    |
| 送付先     | US     |
| 数量       | 1      |
| 状態       | NEW    |
| 価格形式   | 計算値そのまま（小数点以下2桁） |
| 配送ポリシー | 「SpeedPAK Economy」を優先（WorldWideより優先） |

## 梱包重量推定ロジック（必ず適用すること）

### 判定フロー

```
1. Keepaから取得したタイトル・カテゴリを分析
2. 以下のキーワードマッチングで梱包パターンを判定
3. package_weight_g + 梱包材重量 = 発送重量
```

### キーワードマッチング表

| キーワード（タイトル・カテゴリ） | 梱包材重量 | 梱包パターン |
|--------------------------------|-----------|-------------|
| ceramic, porcelain, pottery, 陶器, 磁器 | **+350g** | 厳重梱包 |
| glass, ガラス | **+400g** | 厳重梱包 |
| electronics, electronic, 電子 | **+150g** | 標準梱包 |
| ironware, cast iron, 鉄器, 鋳物 | **+180g** | 標準梱包 |
| kitchen, キッチン, plastic, プラスチック | **+150g** | 標準梱包 |
| tool, metal, 工具, 金属 | **+80g** | 軽量梱包 |
| clothing, fabric, 衣類, 布 | **+40g** | 軽量梱包 |
| 上記に該当しない | **+150g** | デフォルト |

**注意**: 複数該当する場合は**最も重い梱包材重量**を採用

### 実装例（疑似コード）

```javascript
function estimatePackagingWeight(title, category) {
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
  if (text.includes("electronics") || text.includes("electronic") ||
      text.includes("電子")) {
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
```

## MCPツール

- extract_asin
- keepa_get_product / keepa_get_tokens
- calculate_price
- ebay_suggest_category
- ebay_get_item_aspects
- ebay_get_policies
- ebay_create_listing
- ebay_update_quantity

## カテゴリ別テンプレート（必ず使用すること）

### 南部鉄器（Nambu Ironware）
```
タイトル: [Brand] Nambu Ironware [Type] [Model] [Pattern] [Color] [Size] [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Iwachu, established in 1902, is one of Japan's premier Nambu ironware manufacturers
based in Morioka, Iwate Prefecture. Each piece is crafted using traditional techniques
passed down through generations, combining functionality with artistic beauty.

Item Specifics:
- Type: Trivet / Teapot / Kettle / Wind Chime
- Material: Cast Iron
- Style: Japanese, Traditional
- Country of Origin: Japan
```

### 陶磁器（Ceramics）
```
タイトル: [Brand] [Type] [Pattern/Style] [Size] Japanese [Region] Ware [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Handcrafted in Japan using centuries-old techniques, this exquisite piece represents
the pinnacle of Japanese ceramic artistry.

Item Specifics:
- Type: Plate / Bowl / Cup
- Material: Porcelain / Stoneware / Ceramic
- Style: Japanese, Traditional
- Country of Origin: Japan
```

### 包丁（Japanese Knives）
```
タイトル: [Brand] [Type] [Steel Type] [Blade Length]mm Japanese Kitchen Knife [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Forged in [Region], Japan, this knife exemplifies the legendary sharpness and
craftsmanship of traditional Japanese bladesmithing.

Item Specifics:
- Type: Santoku / Gyuto / Nakiri / Deba
- Blade Material: VG-10 / Blue Steel / White Steel
- Handle Material: Wood / Pakkawood
- Country of Origin: Japan
```

### 食品（Foods & Beverages）
```
タイトル: [Brand] [Product Name] [Type] [Weight/Volume] Japanese [Feature] [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Authentic Japanese [product type] crafted with premium ingredients and traditional methods.
Perfect for [use case].

**必須セクション（説明文に必ず含めること）:**
- Ingredients（成分表示）: 原材料を英語で記載
- Nutrition Facts（栄養成分表）: 可能な限り記載
- Allergen Information: アレルゲン情報（Contains: / May contain:）
- Best Before/Expiry Date: 賞味期限・消費期限
- Storage Instructions: 保存方法
- 成分分析表へのリンク（ある場合）

Item Specifics:
- Type: Tea / Seasoning / Snack / Beverage
- Form: Powder / Liquid / Solid
- Country of Origin: Japan
```

### 化粧品・スキンケア（Cosmetics & Skincare）
```
タイトル: [Brand] [Product Name] [Type] [Volume/Weight] Japanese [Key Ingredient] [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Premium Japanese skincare formulated with [key ingredients] for [benefit].
Developed in Japan with meticulous attention to quality and efficacy.

**必須セクション（説明文に必ず含めること）:**
- Ingredients（全成分表示）: INCI名で記載
- How to Use: 使用方法
- Skin Type: 対象肌質
- Key Benefits: 主な効果
- Precautions: 注意事項（For external use only等）
- Volume/Net Weight: 内容量
- 成分分析表・安全性データへのリンク（ある場合）

Item Specifics:
- Type: Serum / Cream / Cleanser / Mask
- Formulation: Gel / Cream / Liquid
- Skin Type: All Skin Types / Dry / Oily / Sensitive
- Country of Origin: Japan
```

### サプリメント（Health Supplements）
```
タイトル: [Brand] [Ingredient Name] [Form] [Quantity] Japanese Supplement [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Premium Japanese dietary supplement featuring [main ingredient] to support [health benefit].
Manufactured in Japan under strict quality control standards.

**必須セクション（説明文に必ず含めること）:**
- Supplement Facts（栄養成分表）
- Ingredients（全成分）: 主成分と添加物を分けて記載
- Suggested Use: 摂取方法・推奨量
- Warnings: 注意事項（妊娠中・授乳中、持病のある方など）
- Disclaimer: 「This product is not intended to diagnose, treat, cure, or prevent any disease.」
- Storage: 保存方法
- 成分分析表・GMP認証等へのリンク（ある場合）

Item Specifics:
- Formulation: Capsule / Tablet / Powder / Liquid
- Main Ingredient: [成分名]
- Active Ingredients: [有効成分]
- Country of Origin: Japan
```

### 石鹸・バス用品（Soaps & Bath Products）
```
タイトル: [Brand] [Type] Soap [Key Ingredient] [Weight] Japanese [Made in Japan/Made Japan/Japan]

説明文イントロ（必須）:
Handcrafted Japanese soap made with natural ingredients including [key ingredient].
Gentle on skin while providing [benefit].

**必須セクション（説明文に必ず含めること）:**
- Ingredients（成分）: 石鹸素地、有効成分等を記載
- How to Use: 使用方法
- Key Features: 主な特徴（無添加、天然成分等）
- Precautions: 注意事項（目に入った場合、肌に合わない場合等）
- Net Weight: 内容量
- 成分表・安全性試験結果へのリンク（ある場合）

Item Specifics:
- Type: Bar Soap / Liquid Soap / Bath Salt
- Scent: [香り] / Unscented
- Skin Type: All Skin Types / Sensitive
- Country of Origin: Japan
```

## 成分表示・外部リンクの記載方法

### HTMLテンプレート（人体に影響がある商品用）

```html
<h3>Ingredients / 成分表示</h3>
<p>[全成分を英語で記載]</p>

<!-- 成分分析表へのリンクがある場合 -->
<p><strong>📄 Ingredient Analysis Report:</strong><br>
<a href="[リンクURL]" target="_blank">View detailed ingredient analysis (PDF)</a></p>

<!-- アレルゲン情報（食品の場合） -->
<h4>Allergen Information</h4>
<p><strong>Contains:</strong> [含まれるアレルゲン]<br>
<strong>May contain traces of:</strong> [コンタミの可能性]</p>

<!-- 注意事項（必須） -->
<h4>⚠️ Precautions</h4>
<ul>
  <li>For external use only（化粧品の場合）</li>
  <li>Keep out of reach of children</li>
  <li>Discontinue use if irritation occurs</li>
  <li>Store in a cool, dry place away from direct sunlight</li>
</ul>

<!-- 免責事項（サプリメントの場合・必須） -->
<p><em>*These statements have not been evaluated by the Food and Drug Administration.
This product is not intended to diagnose, treat, cure, or prevent any disease.</em></p>
```

### 成分表示の自動挿入ルール

Keepaから取得した商品情報に以下のキーワードが含まれる場合、**自動的に成分表示セクションを追加**:

| カテゴリ | トリガーキーワード | 必須セクション |
|---------|-----------------|--------------|
| 食品 | 食品、tea、supplement、snack、seasoning | Ingredients、Allergen Info |
| 化粧品 | 化粧品、cosmetic、skincare、cream、serum、lotion | Ingredients (INCI)、Precautions |
| サプリメント | サプリ、supplement、vitamin、collagen | Supplement Facts、Disclaimer |
| 石鹸・バス | 石鹸、soap、bath、shampoo | Ingredients、How to Use |

### 成分分析表リンクの記載例

```
Amazon商品ページや公式サイトに成分分析表へのリンクがある場合:

<p><strong>📄 Quality & Safety Documentation:</strong></p>
<ul>
  <li><a href="[URL]">Ingredient Analysis Report (PDF)</a></li>
  <li><a href="[URL]">Safety Test Results</a></li>
  <li><a href="[URL]">GMP Certification</a></li>
  <li><a href="[URL]">Official Product Page (Japanese)</a></li>
</ul>
```

## 配送情報テンプレート（説明文に必ず含めること）

```html
<h3>Shipping Information</h3>
<p><strong>FREE SHIPPING</strong> via SpeedPAK International</p>
<ul>
  <li>Estimated delivery: 7-14 business days</li>
  <li>Tracking number provided</li>
  <li>Ships from Japan</li>
</ul>

<h4>DDP (Delivered Duty Paid) - US Orders</h4>
<p>For US customers, import duties and taxes are INCLUDED in the price.
No additional charges upon delivery.</p>

<h4>Other Countries (UK, EU, AU)</h4>
<p>Import duties and taxes may apply and are the buyer's responsibility.
Please check your local customs regulations.</p>
```
