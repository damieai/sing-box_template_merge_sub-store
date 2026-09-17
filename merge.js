const { name, type = "0", rules: rulesFile } = $arguments;

// sing-box 1.15 hybrid template adapter for Sub-Store.
// - Keeps region urltest groups region-only.
// - Expands all real nodes only in Proxy and AI.
// - Removes empty region groups and stale references.
// - Validates outbound dependencies before emitting JSON.

let config = JSON.parse($files[0]);

if (!config || !Array.isArray(config.outbounds)) {
  throw new Error("模板缺少 outbounds 数组");
}

// 可选：读取自定义路由规则文件
if (rulesFile) {
  try {
    const raw = await produceArtifact({
      type: "file",
      name: rulesFile,
    });

    const customRules = raw ? JSON.parse(raw) : [];

    if (
      Array.isArray(customRules) &&
      config.route &&
      Array.isArray(config.route.rules)
    ) {
      const existing = new Set(
        config.route.rules.map(rule => JSON.stringify(rule))
      );

      const additions = customRules.filter(
        rule => !existing.has(JSON.stringify(rule))
      );

      const globalIndex = config.route.rules.findIndex(
        rule =>
          typeof rule.clash_mode === "string" &&
          rule.clash_mode.toLowerCase() === "global"
      );

      config.route.rules.splice(
        globalIndex >= 0
          ? globalIndex + 1
          : config.route.rules.length,
        0,
        ...additions
      );
    }
  } catch (error) {
    console.log("自定义规则读取失败，已跳过: " + error);
  }
}

// 从 Sub-Store 获取订阅或组合节点
let proxies = await produceArtifact({
  name,
  type: /^1$|col/i.test(type)
    ? "collection"
    : "subscription",
  platform: "sing-box",
  produceType: "internal",
});

if (!Array.isArray(proxies)) {
  throw new Error(
    "Sub-Store 未返回有效的 sing-box 节点数组"
  );
}

// 获取模板原本占用的所有 tag
const reservedTags = new Set(
  config.outbounds
    .filter(
      outbound =>
        outbound &&
        typeof outbound.tag === "string"
    )
    .map(outbound => outbound.tag)
);

// 删除无效节点、重名节点和与策略组同名的节点
const proxyMap = new Map();

for (const proxy of proxies) {
  if (
    !proxy ||
    typeof proxy.tag !== "string" ||
    !proxy.tag.trim()
  ) {
    continue;
  }

  if (
    reservedTags.has(proxy.tag) ||
    proxyMap.has(proxy.tag)
  ) {
    continue;
  }

  proxyMap.set(proxy.tag, proxy);
}

proxies = [...proxyMap.values()];

if (proxies.length === 0) {
  throw new Error(
    "没有可注入的订阅节点；请检查 name/type 参数或节点 tag 冲突"
  );
}

// 地区节点名称识别规则
const REGION_GROUPS = {
  "🇭🇰Hong Kong":
    /(?:🇭🇰|香港|Hong\s*Kong|\bHK(?:G)?\b)/i,

  "🇹🇼Taiwan":
    /(?:🇹🇼|台湾|台灣|Taiwan|Taipei|\bTW\b)/i,

  "🇯🇵Japan":
    /(?:🇯🇵|日本|Japan|Tokyo|Osaka|\bJP\b)/i,

  "🇰🇷Korea":
    /(?:🇰🇷|韩国|韓國|Korea|Seoul|\bKR\b)/i,

  "🇸🇬Singapore":
    /(?:🇸🇬|新加坡|狮城|獅城|Singapore|\bSG\b)/i,

  "🇺🇸United States":
    /(?:🇺🇸|美国|美國|United\s*States|America|Los\s*Angeles|San\s*Jose|Seattle|Dallas|New\s*York|\bUS(?:A)?\b)/i,
};

const allTags = proxies.map(proxy => proxy.tag);

const regionTags = Object.fromEntries(
  Object.keys(REGION_GROUPS).map(tag => [
    tag,
    [],
  ])
);

const otherTags = [];

// 根据节点名称进行地区分类
for (const tag of allTags) {
  let matched = false;

  for (
    const [groupTag, pattern]
    of Object.entries(REGION_GROUPS)
  ) {
    if (pattern.test(tag)) {
      regionTags[groupTag].push(tag);
      matched = true;
      break;
    }
  }

  if (!matched) {
    otherTags.push(tag);
  }
}

// 建立策略组索引
const groupByTag = new Map(
  config.outbounds.map(outbound => [
    outbound.tag,
    outbound,
  ])
);

// Auto 组使用全部真实节点
const autoGroup = groupByTag.get("⚡️Auto");

if (
  !autoGroup ||
  !Array.isArray(autoGroup.outbounds)
) {
  throw new Error("模板缺少 ⚡️Auto 策略组");
}

autoGroup.outbounds = [...allTags];

// 填充各地区测速组
for (
  const [groupTag, tags]
  of Object.entries(regionTags)
) {
  const group = groupByTag.get(groupTag);

  if (
    group &&
    Array.isArray(group.outbounds)
  ) {
    group.outbounds = [...tags];
  }
}

// 未识别节点进入 Other
const otherGroup = groupByTag.get("🌍Other");

if (
  otherGroup &&
  Array.isArray(otherGroup.outbounds)
) {
  otherGroup.outbounds = [...otherTags];
}

// Proxy 与 AI 策略组展开全部真实节点
// 其他业务策略组保持简洁，通过 Proxy 或 Auto 复用节点
for (const groupTag of [
  "✈️proxy",
  "🤖AI",
]) {
  const group = groupByTag.get(groupTag);

  if (
    group &&
    Array.isArray(group.outbounds)
  ) {
    group.outbounds.push(...allTags);

    group.outbounds = [
      ...new Set(group.outbounds),
    ];
  }
}

// 将真实订阅节点加入最终 outbounds
config.outbounds.push(...proxies);

// 找出没有任何节点的地区组
const removableRegionTags = new Set([
  ...Object.entries(regionTags)
    .filter(([, tags]) => tags.length === 0)
    .map(([tag]) => tag),

  ...(
    otherTags.length === 0
      ? ["🌍Other"]
      : []
  ),
]);

// 删除空地区组
config.outbounds = config.outbounds.filter(
  outbound =>
    !removableRegionTags.has(outbound.tag)
);

// 清理其他策略组中对空地区组的引用
for (const group of config.outbounds) {
  if (!Array.isArray(group.outbounds)) {
    continue;
  }

  group.outbounds = [
    ...new Set(
      group.outbounds.filter(
        tag =>
          !removableRegionTags.has(tag)
      )
    ),
  ];

  // default 已不存在时自动修复
  if (
    group.default &&
    !group.outbounds.includes(group.default)
  ) {
    group.default = group.outbounds[0];
  }

  if (
    group.type === "selector" &&
    !group.default &&
    group.outbounds.length > 0
  ) {
    group.default = group.outbounds[0];
  }
}

// 收集最终真实存在的 outbound 和 endpoint tag
const finalTags = new Set([
  ...config.outbounds
    .filter(
      outbound =>
        outbound &&
        typeof outbound.tag === "string"
    )
    .map(outbound => outbound.tag),

  ...(
    Array.isArray(config.endpoints)
      ? config.endpoints
          .map(endpoint => endpoint.tag)
          .filter(Boolean)
      : []
  ),
]);

const errors = [];

// 检查策略组和链式节点依赖
for (const outbound of config.outbounds) {
  for (
    const dependency
    of outbound.outbounds || []
  ) {
    if (!finalTags.has(dependency)) {
      errors.push(
        `${outbound.tag} -> ${dependency}`
      );
    }
  }

  if (
    outbound.detour &&
    !finalTags.has(outbound.detour)
  ) {
    errors.push(
      `${outbound.tag}.detour -> ${outbound.detour}`
    );
  }
}

// 检查路由规则引用
for (
  const rule
  of config.route?.rules || []
) {
  if (
    rule.outbound &&
    !finalTags.has(rule.outbound)
  ) {
    errors.push(
      `route rule -> ${rule.outbound}`
    );
  }
}

// 检查最终出口
if (
  config.route?.final &&
  !finalTags.has(config.route.final)
) {
  errors.push(
    `route.final -> ${config.route.final}`
  );
}

// 存在悬空引用时停止生成
if (errors.length > 0) {
  throw new Error(
    "发现不存在的 outbound dependency:\n" +
    [...new Set(errors)].join("\n")
  );
}

// 输出最终配置
$content = JSON.stringify(
  config,
  null,
  2
);
