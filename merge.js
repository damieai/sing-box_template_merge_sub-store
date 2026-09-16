/**
 * Sub-Store merge script
 *
 * Target:
 *   wuziwei/sing-box-config-template
 *   client template/client sb-1.15.json
 *
 * Purpose:
 *   让 wuziwei 的 sing-box 1.15 模板真正适配 Sub-Store 动态订阅。
 *
 * 核心原则：
 *   1. 不修改模板的 DNS / Route / Rule Set / Inbound 等设计。
 *   2. 动态插入 Sub-Store 真实订阅节点。
 *   3. 删除模板策略组中引用但实际上不存在的示例节点。
 *   4. Latency 只放 JP/KR。
 *   5. Bandwidth 只放 US/CA。
 *   6. 其他普通策略组加入全部真实节点。
 *   7. Relay 只加入无 detour 的终端节点。
 *   8. 自动修复失效 default。
 *   9. 最终执行 outbound dependency 完整性检查。
 */

const {
  name,
  type = "0",
  rules: rules_file
} = $arguments;


// ============================================================
// 0. 基础工具
// ============================================================

function unique(arr) {
  return [...new Set(arr)];
}

function hasText(text, patterns) {
  const value = String(text || "").toLowerCase();

  return patterns.some(pattern => {
    if (pattern instanceof RegExp) {
      return pattern.test(value);
    }

    return value.includes(String(pattern).toLowerCase());
  });
}


// ============================================================
// 1. 地区识别
//
// 目标不是强制修改节点名称。
// 只是根据节点 tag 判断属于哪个地区。
// ============================================================

const REGION_PATTERNS = {

  JP: [
    "🇯🇵",
    "日本",
    "东京",
    "大阪",
    "埼玉",
    "Japan",
    "Tokyo",
    "Osaka",
    /\bjp\b/i,
    /\bjpn\b/i
  ],

  KR: [
    "🇰🇷",
    "韩国",
    "韓國",
    "首尔",
    "首爾",
    "Korea",
    "Seoul",
    /\bkr\b/i,
    /\bkor\b/i
  ],

  US: [
    "🇺🇸",
    "美国",
    "美國",
    "美西",
    "美东",
    "美東",
    "洛杉矶",
    "洛杉磯",
    "圣何塞",
    "聖何塞",
    "西雅图",
    "西雅圖",
    "纽约",
    "紐約",
    "达拉斯",
    "達拉斯",
    "芝加哥",
    "United States",
    "America",
    "Los Angeles",
    "San Jose",
    "Seattle",
    "New York",
    "Dallas",
    "Chicago",
    /\bus\b/i,
    /\busa\b/i
  ],

  CA: [
    "🇨🇦",
    "加拿大",
    "Canada",
    "Toronto",
    "Vancouver",
    "Montreal",
    "多伦多",
    "多倫多",
    "温哥华",
    "溫哥華",
    "蒙特利尔",
    "蒙特利爾",
    /\bca\b/i,
    /\bcan\b/i
  ],

  HK: [
    "🇭🇰",
    "香港",
    "Hong Kong",
    "HongKong",
    /\bhk\b/i,
    /\bhkg\b/i
  ],

  TW: [
    "🇹🇼",
    "台湾",
    "台灣",
    "Taiwan",
    "Taipei",
    "台北",
    /\btw\b/i,
    /\btwn\b/i
  ],

  SG: [
    "🇸🇬",
    "新加坡",
    "狮城",
    "獅城",
    "Singapore",
    /\bsg\b/i,
    /\bsgp\b/i
  ],

  GB: [
    "🇬🇧",
    "英国",
    "英國",
    "伦敦",
    "倫敦",
    "United Kingdom",
    "Britain",
    "London",
    /\buk\b/i,
    /\bgb\b/i
  ],

  DE: [
    "🇩🇪",
    "德国",
    "德國",
    "Germany",
    "Frankfurt",
    "法兰克福",
    "法蘭克福",
    /\bde\b/i
  ],

  FR: [
    "🇫🇷",
    "法国",
    "法國",
    "France",
    "Paris",
    "巴黎",
    /\bfr\b/i
  ],

  AU: [
    "🇦🇺",
    "澳大利亚",
    "澳大利亞",
    "澳洲",
    "Australia",
    "Sydney",
    "Melbourne",
    "悉尼",
    "墨尔本",
    "墨爾本",
    /\bau\b/i
  ]
};


function detectRegion(tag) {

  for (const [region, patterns] of Object.entries(REGION_PATTERNS)) {

    if (hasText(tag, patterns)) {
      return region;
    }
  }

  return "OTHER";
}


// ============================================================
// 2. 读取模板
// ============================================================

if (!$files || !$files[0]) {
  throw new Error("没有读取到 Sub-Store 模板文件");
}

let config;

try {
  config = JSON.parse($files[0]);
} catch (e) {
  throw new Error(
    "模板不是有效 JSON: " + e.message
  );
}

if (!Array.isArray(config.outbounds)) {
  throw new Error(
    "模板中不存在有效的 outbounds 数组"
  );
}


// ============================================================
// 3. 可选：插入自定义规则
//
// 保留 LongLights merge.js 的 rules 参数能力。
// ============================================================

if (rules_file) {

  try {

    const raw = await produceArtifact({
      type: "file",
      name: rules_file
    });

    if (raw) {

      const customRules = JSON.parse(raw);

      if (
        Array.isArray(customRules) &&
        config.route &&
        Array.isArray(config.route.rules)
      ) {

        const existing = new Set(
          config.route.rules.map(
            rule => JSON.stringify(rule)
          )
        );

        const newRules = customRules.filter(
          rule => !existing.has(
            JSON.stringify(rule)
          )
        );

        const globalIndex =
          config.route.rules.findIndex(
            rule =>
              typeof rule.clash_mode === "string" &&
              rule.clash_mode.toLowerCase() === "global"
          );

        if (globalIndex >= 0) {

          config.route.rules.splice(
            globalIndex + 1,
            0,
            ...newRules
          );

        } else {

          config.route.rules.push(
            ...newRules
          );
        }
      }
    }

  } catch (e) {

    console.log(
      "[WARN] 自定义 rules 加载失败，继续生成配置: " +
      e.message
    );
  }
}


// ============================================================
// 4. 从 Sub-Store 获取订阅节点
// ============================================================

let proxies = await produceArtifact({

  name,

  type:
    /^1$|col/i.test(type)
      ? "collection"
      : "subscription",

  platform: "sing-box",

  produceType: "internal"
});


if (!Array.isArray(proxies)) {

  throw new Error(
    "Sub-Store 没有返回有效的 sing-box 节点数组"
  );
}


// ============================================================
// 5. 基础节点清理
// ============================================================

proxies = proxies.filter(
  proxy =>
    proxy &&
    typeof proxy === "object" &&
    typeof proxy.tag === "string" &&
    proxy.tag.trim() !== ""
);


// ============================================================
// 6. 获取模板原始 outbound tags
// ============================================================

const templateTags = new Set(

  config.outbounds

    .filter(
      outbound =>
        outbound &&
        typeof outbound.tag === "string"
    )

    .map(
      outbound => outbound.tag
    )
);


// ============================================================
// 7. 防止订阅节点和模板 tag 冲突
//
// 例如订阅节点恰好叫：
// direct
// GLOBAL
// Relay
// ✈️proxy
//
// 这种节点不能覆盖模板策略组。
// ============================================================

proxies = proxies.filter(
  proxy =>
    !templateTags.has(proxy.tag)
);


// ============================================================
// 8. 订阅节点 tag 去重
//
// sing-box outbound tag 应保持唯一。
// ============================================================

const proxyMap = new Map();

for (const proxy of proxies) {

  if (!proxyMap.has(proxy.tag)) {
    proxyMap.set(
      proxy.tag,
      proxy
    );
  }
}

proxies = [...proxyMap.values()];


if (proxies.length === 0) {

  throw new Error(
    "订阅中没有可使用的有效节点"
  );
}


// ============================================================
// 9. 地区分类
// ============================================================

const regions = {
  JP: [],
  KR: [],
  US: [],
  CA: [],
  HK: [],
  TW: [],
  SG: [],
  GB: [],
  DE: [],
  FR: [],
  AU: [],
  OTHER: []
};


for (const proxy of proxies) {

  const region =
    detectRegion(proxy.tag);

  regions[region].push(
    proxy.tag
  );
}


// ============================================================
// 10. 创建几个常用集合
// ============================================================

const allProxyTags =
  proxies.map(
    proxy => proxy.tag
  );


const terminalProxyTags =
  proxies

    .filter(
      proxy => !proxy.detour
    )

    .map(
      proxy => proxy.tag
    );


const jpKrTags = unique([
  ...regions.JP,
  ...regions.KR
]);


const usCaTags = unique([
  ...regions.US,
  ...regions.CA
]);


// ============================================================
// 11. 把真实订阅节点加入最终 outbounds
// ============================================================

config.outbounds.push(
  ...proxies
);


// ============================================================
// 12. 构建最终合法 outbound tag 集合
// ============================================================

let validTags = new Set(

  config.outbounds

    .filter(
      outbound =>
        outbound &&
        typeof outbound.tag === "string"
    )

    .map(
      outbound => outbound.tag
    )
);


// ============================================================
// 13. 第一轮清理模板幽灵节点
//
// 例如模板：
//
// ⚡️Latency
// ├── 🇯🇵JP1-hy2    存在
// ├── 🇯🇵JP2-hy2    不存在
// └── 🇰🇷SK1-hy2    不存在
//
// 后两个直接删除。
// ============================================================

for (const group of config.outbounds) {

  if (!Array.isArray(group.outbounds)) {
    continue;
  }

  group.outbounds =
    group.outbounds.filter(
      tag => validTags.has(tag)
    );
}


// ============================================================
// 14. 策略组注入规则
//
// 这是本适配器最关键的一部分。
// ============================================================

for (const group of config.outbounds) {

  if (!Array.isArray(group.outbounds)) {
    continue;
  }


  // ----------------------------------------------------------
  // Direct-Out
  //
  // 保持模板原样。
  // ----------------------------------------------------------

  if (group.tag === "Direct-Out") {
    continue;
  }


  // ----------------------------------------------------------
  // Relay
  //
  // 只能添加无 detour 的 terminal 节点。
  //
  // 否则可能形成：
//
// Relay
//   ↓
// node(detour=Relay)
//   ↓
// Relay
//
// 的递归依赖。
// ----------------------------------------------------------

  if (group.tag === "Relay") {

    group.outbounds.push(
      ...terminalProxyTags
    );

    group.outbounds =
      unique(group.outbounds);

    continue;
  }


  // ----------------------------------------------------------
  // Latency JP/KR
  //
  // 专门针对模板：
//
// ⚡️Latency(🇯🇵/🇰🇷)
//
// 只加入日本、韩国。
// ----------------------------------------------------------

  if (
    group.tag.includes("Latency") &&
    (
      group.tag.includes("🇯🇵") ||
      group.tag.includes("🇰🇷")
    )
  ) {

    if (jpKrTags.length > 0) {

      group.outbounds.push(
        ...jpKrTags
      );

    } else {

      // 如果机场节点名称完全无法识别地区，
      // 不让 urltest 变成空组。
      //
      // fallback = 全节点

      console.log(
        "[WARN] 无法识别 JP/KR 节点，Latency 使用全部节点作为 fallback"
      );

      group.outbounds.push(
        ...allProxyTags
      );
    }

    group.outbounds =
      unique(group.outbounds);

    continue;
  }


  // ----------------------------------------------------------
  // Bandwidth US/CA
  //
  // 专门针对模板：
//
// 🚀Bandwidth(🇺🇸/🇨🇦)
//
// 只加入美国、加拿大。
// ----------------------------------------------------------

  if (
    group.tag.includes("Bandwidth") &&
    (
      group.tag.includes("🇺🇸") ||
      group.tag.includes("🇨🇦")
    )
  ) {

    if (usCaTags.length > 0) {

      group.outbounds.push(
        ...usCaTags
      );

    } else {

      console.log(
        "[WARN] 无法识别 US/CA 节点，Bandwidth 使用全部节点作为 fallback"
      );

      group.outbounds.push(
        ...allProxyTags
      );
    }

    group.outbounds =
      unique(group.outbounds);

    continue;
  }


  // ----------------------------------------------------------
  // 普通 selector / urltest
  //
  // Spotify / YouTube / Proxy / GLOBAL 等，
  // 都允许用户选择真实订阅节点。
  // ----------------------------------------------------------

  group.outbounds.push(
    ...allProxyTags
  );

  group.outbounds =
    unique(group.outbounds);
}


// ============================================================
// 15. 再次过滤不存在 dependency
// ============================================================

for (const group of config.outbounds) {

  if (!Array.isArray(group.outbounds)) {
    continue;
  }

  group.outbounds =
    group.outbounds.filter(
      tag => validTags.has(tag)
    );
}


// ============================================================
// 16. 修复 selector default
//
// 如果模板：
//
// default: 🇯🇵JP2-hy2
//
// 但这个节点已经不存在，
// 则自动选择当前 selector 的第一个有效 outbound。
// ============================================================

for (const group of config.outbounds) {

  if (
    group.type !== "selector" ||
    !Array.isArray(group.outbounds)
  ) {
    continue;
  }


  if (
    group.default &&
    !group.outbounds.includes(
      group.default
    )
  ) {

    if (group.outbounds.length > 0) {

      group.default =
        group.outbounds[0];

    } else {

      delete group.default;
    }
  }
}


// ============================================================
// 17. 空策略组保护
// ============================================================

for (const group of config.outbounds) {

  if (
    !["selector", "urltest"].includes(
      group.type
    )
  ) {
    continue;
  }


  if (!Array.isArray(group.outbounds)) {
    group.outbounds = [];
  }


  if (group.outbounds.length === 0) {

    console.log(
      `[WARN] ${group.tag} 为空，使用全部订阅节点 fallback`
    );

    group.outbounds.push(
      ...allProxyTags
    );


    if (
      group.type === "selector" &&
      !group.default
    ) {

      group.default =
        allProxyTags[0];
    }
  }
}


// ============================================================
// 18. selector default 第二次检查
// ============================================================

for (const group of config.outbounds) {

  if (
    group.type !== "selector" ||
    !Array.isArray(group.outbounds)
  ) {
    continue;
  }


  if (
    group.default &&
    !group.outbounds.includes(
      group.default
    )
  ) {

    group.default =
      group.outbounds[0];
  }
}


// ============================================================
// 19. 检查重复 outbound tag
// ============================================================

const tagCounter = new Map();


for (const outbound of config.outbounds) {

  if (
    !outbound ||
    typeof outbound.tag !== "string"
  ) {
    continue;
  }


  tagCounter.set(
    outbound.tag,
    (tagCounter.get(outbound.tag) || 0) + 1
  );
}


const duplicatedTags =
  [...tagCounter.entries()]

    .filter(
      ([_, count]) => count > 1
    )

    .map(
      ([tag]) => tag
    );


if (duplicatedTags.length > 0) {

  throw new Error(
    "发现重复 outbound tag:\n" +
    duplicatedTags.join("\n")
  );
}


// ============================================================
// 20. 最终 dependency 完整性检查
// ============================================================

const finalTags = new Set(

  config.outbounds

    .filter(
      outbound =>
        outbound &&
        typeof outbound.tag === "string"
    )

    .map(
      outbound => outbound.tag
    )
);


const