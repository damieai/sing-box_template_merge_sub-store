const { name, type = "0", rules: rulesFile } = $arguments;

// ========================================
// 1. 读取模板，并明确区分 JSON / HTML 错误
// ========================================

let config;

try {
  const raw = String($files[0] ?? "")
    .replace(/^\uFEFF/, "")
    .trim();

  if (!raw) {
    throw new Error("第一个关联文件为空");
  }

  if (raw.startsWith("<")) {
    throw new Error(
      "第一个关联文件返回的是 HTML/XML，不是 JSON。" +
      "请检查模板文件内容或下载链接。" +
      "内容开头：" + raw.slice(0, 100)
    );
  }

  config = JSON.parse(raw);
} catch (error) {
  throw new Error(
    "【读取模板失败】" +
    (error.message || String(error))
  );
}

if (!config || !Array.isArray(config.outbounds)) {
  throw new Error(
    "【模板结构错误】模板缺少 outbounds 数组"
  );
}

// ========================================
// 2. 可选：读取自定义路由规则
// ========================================

if (rulesFile) {
  try {
    const raw = await produceArtifact({
      type: "file",
      name: rulesFile,
    });

    const customRules = raw ? JSON.parse(raw) : [];

    if (
      Array.isArray(customRules) &&
      Array.isArray(config.route?.rules)
    ) {
      const existing = new Set(
        config.route.rules.map(
          rule => JSON.stringify(rule)
        )
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
    console.log(
      "自定义规则读取失败，已跳过: " +
      (error.message || String(error))
    );
  }
}

// ========================================
// 3. 获取订阅或组合节点
// ========================================

let proxies;

try {
  proxies = await produceArtifact({
    name,
    type: /^1$|col/i.test(type)
      ? "collection"
      : "subscription",
    platform: "sing-box",
    produceType: "internal",
  });
} catch (error) {
  throw new Error(
    "【生成订阅节点失败】" +
    (error.message || String(error))
  );
}

if (!Array.isArray(proxies)) {
  throw new Error(
    "【订阅结果错误】Sub-Store 未返回有效的 sing-box 节点数组"
  );
}

const templateGroups = config.outbounds;

const reservedTags = new Set(
  [
    ...templateGroups.map(
      outbound => outbound?.tag
    ),
    ...(config.endpoints || []).map(
      endpoint => endpoint?.tag
    ),
  ].filter(tag => typeof tag === "string")
);

// 删除无效节点、重名节点和与模板标签冲突的节点
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
    proxy.tag === "{all}" ||
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

const allTags = proxies.map(
  proxy => proxy.tag
);

// ========================================
// 4. 按节点名称分类地区
// ========================================

const REGION_GROUPS = {
  "🇭🇰Hong Kong":
    /(?:🇭🇰|香港|Hong\s*Kong|\bHK(?:G)?\b)/i,

  "🇹🇼Taiwan":
    /(?:🇹🇼|台湾|台灣|臺灣|Taiwan|Taipei|\bTW\b)/i,

  "🇯🇵Japan":
    /(?:🇯🇵|日本|Japan|Tokyo|Osaka|\bJP\b)/i,

  "🇰🇷Korea":
    /(?:🇰🇷|韩国|韓國|Korea|Seoul|\bKR\b)/i,

  "🇸🇬Singapore":
    /(?:🇸🇬|新加坡|狮城|獅城|Singapore|\bSG\b)/i,

  "🇺🇸United States":
    /(?:🇺🇸|美国|美國|United\s*States|America|Los\s*Angeles|San\s*Jose|Seattle|Dallas|New\s*York|\bUS(?:A)?\b)/i,
};

const regionTags = Object.fromEntries(
  Object.keys(REGION_GROUPS).map(
    tag => [tag, []]
  )
);

const otherTags = [];

for (const tag of allTags) {
  const match = Object.entries(REGION_GROUPS).find(
    ([, pattern]) => pattern.test(tag)
  );

  if (match) {
    regionTags[match[0]].push(tag);
  } else {
    otherTags.push(tag);
  }
}

const groupByTag = new Map(
  templateGroups.map(
    outbound => [outbound.tag, outbound]
  )
);

// ========================================
// 5. 处理模板 filter
// ========================================

// 当前模板的 filter.keywords 使用正则表达式。
// 只筛选订阅节点，不删除 vpn 中显式指定的 auto/direct。
function filteredNodeTags(
  group,
  candidates = allTags
) {
  let selected = [...candidates];

  if (group.filter === undefined) {
    return selected;
  }

  if (!Array.isArray(group.filter)) {
    throw new Error(
      `${group.tag}: filter 必须为数组`
    );
  }

  for (const filter of group.filter) {
    if (
      !filter ||
      !["include", "exclude"].includes(filter.action) ||
      !Array.isArray(filter.keywords)
    ) {
      throw new Error(
        `${group.tag}: 不支持的 filter 格式`
      );
    }

    let patterns;

    try {
      patterns = filter.keywords.map(
        keyword => new RegExp(keyword, "i")
      );
    } catch (error) {
      throw new Error(
        `${group.tag}: filter 正则表达式无效: ` +
        (error.message || String(error))
      );
    }

    selected = selected.filter(tag => {
      const matched = patterns.some(
        pattern => pattern.test(tag)
      );

      return filter.action === "include"
        ? matched
        : !matched;
    });
  }

  return selected;
}

// ========================================
// 6. 展开非地区组中的 {all}
// ========================================

// 包括 vpn 和旧 auto。
// 地区组稍后单独填充，避免混入其他地区节点。
const managedRegionTags = new Set([
  ...Object.keys(REGION_GROUPS),
  "🌍Other",
]);

for (const group of templateGroups) {
  if (
    !Array.isArray(group.outbounds) ||
    managedRegionTags.has(group.tag)
  ) {
    continue;
  }

  const selected = filteredNodeTags(group);

  group.outbounds = [
    ...new Set(
      group.outbounds.flatMap(
        tag => tag === "{all}"
          ? selected
          : [tag]
      )
    ),
  ];
}

// ========================================
// 7. 填充主 Auto 和地区测速组
// ========================================

const autoGroup = groupByTag.get("⚡️Auto");

if (
  !autoGroup ||
  !Array.isArray(autoGroup.outbounds)
) {
  throw new Error(
    "模板缺少 ⚡️Auto 策略组；请使用参考模板或最新修改版 JSON"
  );
}

autoGroup.outbounds = filteredNodeTags(autoGroup);

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

const otherGroup = groupByTag.get("🌍Other");

if (
  otherGroup &&
  Array.isArray(otherGroup.outbounds)
) {
  otherGroup.outbounds = [...otherTags];
}

// ========================================
// 8. Proxy 和 AI 展开真实节点
// ========================================

for (const groupTag of ["✈️proxy", "🤖AI"]) {
  const group = groupByTag.get(groupTag);

  if (
    group &&
    Array.isArray(group.outbounds)
  ) {
    group.outbounds = [
      ...new Set([
        ...group.outbounds,
        ...filteredNodeTags(group),
      ]),
    ];
  }
}

// filter 是模板元数据，不传给 sing-box 内核。
for (const group of templateGroups) {
  delete group.filter;
}

// 加入真实订阅节点
config.outbounds.push(...proxies);

// ========================================
// 9. 清理空地区组及其引用
// ========================================

const removableRegionTags = new Set([
  ...Object.entries(regionTags)
    .filter(([, tags]) => tags.length === 0)
    .map(([tag]) => tag),

  ...(otherTags.length === 0
    ? ["🌍Other"]
    : []),
]);

config.outbounds = config.outbounds.filter(
  outbound =>
    !removableRegionTags.has(outbound.tag)
);

for (const group of config.outbounds) {
  if (!Array.isArray(group.outbounds)) {
    continue;
  }

  group.outbounds = [
    ...new Set(
      group.outbounds.filter(
        tag => !removableRegionTags.has(tag)
      )
    ),
  ];

  if (
    group.default &&
    !group.outbounds.includes(group.default)
  ) {
    if (group.outbounds.length > 0) {
      group.default = group.outbounds[0];
    } else {
      delete group.default;
    }
  }

  if (
    group.type === "selector" &&
    !group.default &&
    group.outbounds.length > 0
  ) {
    group.default = group.outbounds[0];
  }
}

// ========================================
// 10. 验证出站依赖
// ========================================

const finalTags = new Set(
  [
    ...config.outbounds.map(
      outbound => outbound?.tag
    ),
    ...(config.endpoints || []).map(
      endpoint => endpoint?.tag
    ),
  ].filter(tag => typeof tag === "string")
);

const errors = [];

for (const outbound of config.outbounds) {
  if (
    ["selector", "urltest"].includes(outbound.type) &&
    !outbound.outbounds?.length
  ) {
    errors.push(
      `${outbound.tag}: 筛选后没有可用节点`
    );
  }

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

// 检查路由规则，包括嵌套逻辑规则
function checkRouteRule(rule) {
  if (
    rule.outbound &&
    !finalTags.has(rule.outbound)
  ) {
    errors.push(
      `route rule -> ${rule.outbound}`
    );
  }

  for (const child of rule.rules || []) {
    checkRouteRule(child);
  }
}

for (const rule of config.route?.rules || []) {
  checkRouteRule(rule);
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

// 检查 DNS 出站依赖
for (const server of config.dns?.servers || []) {
  if (
    server.detour &&
    !finalTags.has(server.detour)
  ) {
    errors.push(
      `dns ${server.tag}.detour -> ${server.detour}`
    );
  }
}

// 检查 HTTP 客户端出站依赖
for (const client of config.http_clients || []) {
  if (
    client.detour &&
    !finalTags.has(client.detour)
  ) {
    errors.push(
      `http_client ${client.tag}.detour -> ${client.detour}`
    );
  }
}

if (errors.length > 0) {
  throw new Error(
    "发现不存在的 outbound dependency 或空策略组:\n" +
    [...new Set(errors)].join("\n")
  );
}

// ========================================
// 11. 输出最终配置
// ========================================

$content = JSON.stringify(config, null, 2);
