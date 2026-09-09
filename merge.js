// Sub-Store 文件处理脚本：替换旧 merge.js，参数 name/type/rules 保持原用法。
// 只展开含 {all} 的分组；filter 在输出前移除。
// 无匹配节点的空组会删除，并清理引用。

const { name, type = "0", rules: rules_file } = $arguments;

// 1. 读取模板
let config = JSON.parse($files[0]);

// 2. 追加自定义规则
if (rules_file) {
  try {
    let customRulesRaw = await produceArtifact({
      type: "file",
      name: rules_file,
    });

    if (customRulesRaw) {
      let customRules = JSON.parse(customRulesRaw);

      let idx = config.route.rules.findIndex(
        r => r.clash_mode === "global"
      );

      if (idx !== -1) {
        const existingRulesStr = new Set(
          config.route.rules.map(r => JSON.stringify(r))
        );

        customRules = customRules.filter(
          r => !existingRulesStr.has(JSON.stringify(r))
        );

        config.route.rules.splice(idx + 1, 0, ...customRules);
      } else {
        config.route.rules.push(...customRules);
      }
    }
  } catch (e) {
    // 保持原版行为：读取或解析失败时跳过自定义规则。
  }
}

// 3. 拉取订阅或合集节点
let proxies = await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? "collection" : "subscription",
  platform: "sing-box",
  produceType: "internal",
});

if (!Array.isArray(proxies) || proxies.length === 0) {
  throw new Error(
    "订阅没有返回节点，请检查 name/type 参数和订阅内容。"
  );
}

const groups = config.outbounds;
const reserved = new Set(groups.map(o => o.tag));
const seen = new Set();

proxies = proxies.filter(p => {
  if (!p || typeof p.tag !== "string" || !p.tag) {
    throw new Error("订阅包含没有 tag 的节点。");
  }

  if (reserved.has(p.tag)) {
    throw new Error(
      `节点名称与模板出站重名：${p.tag}，请在订阅中重命名。`
    );
  }

  if (seen.has(p.tag)) return false;

  seen.add(p.tag);
  return true;
});

// 4. 仅在显式 {all} 的位置注入节点。
// 其他策略组保持模板原有的入口，不额外追加全部节点。
for (const group of groups) {
  const filters = group.filter || [];

  if (!Array.isArray(filters)) {
    throw new Error(`${group.tag}: filter 必须是数组。`);
  }

  const predicates = filters.map(f => {
    if (
      !["include", "exclude"].includes(f.action) ||
      !Array.isArray(f.keywords)
    ) {
      throw new Error(`${group.tag}: 不支持的 filter 格式。`);
    }

    // keywords 中每个字符串按正则表达式处理。
    // 同一条规则内 OR，多条规则之间 AND。
    const patterns = f.keywords.map(
      pattern => new RegExp(pattern)
    );

    return tag => {
      const matches = patterns.some(
        pattern => pattern.test(tag)
      );

      return f.action === "include" ? matches : !matches;
    };
  });

  if (Array.isArray(group.outbounds)) {
    const selected = proxies
      .filter(p => predicates.every(test => test(p.tag)))
      .map(p => p.tag);

    group.outbounds = [
      ...new Set(
        group.outbounds.flatMap(
          tag => tag === "{all}" ? selected : [tag]
        )
      ),
    ];
  }

  // filter 是模板字段，不能留在最终核心配置中。
  delete group.filter;
}

config.outbounds.push(...proxies);

// 5. 删除空分组并递归清理引用。
// 不把空地区组自动填成全部节点或直连。
let changed;

do {
  changed = false;

  const empty = new Set(
    config.outbounds
      .filter(
        o =>
          ["selector", "urltest"].includes(o.type) &&
          Array.isArray(o.outbounds) &&
          o.outbounds.length === 0
      )
      .map(o => o.tag)
  );

  if (empty.size) {
    changed = true;

    config.outbounds = config.outbounds.filter(
      o => !empty.has(o.tag)
    );

    for (const o of config.outbounds) {
      if (Array.isArray(o.outbounds)) {
        o.outbounds = o.outbounds.filter(
          tag => !empty.has(tag)
        );
      }
    }
  }
} while (changed);

// 6. 检查分组引用，修复已被移除的默认选项。
const tags = new Set(config.outbounds.map(o => o.tag));

for (const o of config.outbounds) {
  if (Array.isArray(o.outbounds)) {
    for (const tag of o.outbounds) {
      if (!tags.has(tag)) {
        throw new Error(
          `${o.tag}: 引用了不存在的出站 ${tag}`
        );
      }
    }

    if (o.default && !o.outbounds.includes(o.default)) {
      o.default = o.outbounds[0];
    }
  }
}

// 7. 检查路由、下载和 DNS 等位置的出站引用。
function checkReferences(value) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    return value.forEach(checkReferences);
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "outbound",
        "detour",
        "download_detour",
        "external_ui_download_detour",
      ].includes(key) &&
      typeof item === "string" &&
      item &&
      !tags.has(item)
    ) {
      throw new Error(
        `${key}: 出站 ${item} 不存在或没有匹配节点，请检查订阅。`
      );
    }

    checkReferences(item);
  }
}

checkReferences(config);

if (config.route?.final && !tags.has(config.route.final)) {
  throw new Error(
    `route.final: 出站 ${config.route.final} 不存在。`
  );
}

// 8. 输出最终配置
$content = JSON.stringify(config, null, 2);
