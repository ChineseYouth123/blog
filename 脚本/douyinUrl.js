#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 解析 Markdown 表格行 → 数组
 * 支持单元格内转义的 `\|`（不会误拆列），返回的单元格内容已还原为字面 `|`
 */
function parseTableRow(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * 重建 Markdown 表格行
 * 单元格内字面 `|` 一律转义为 `\|`，保证表格结构不被破坏
 */
function buildTableRow(cells) {
  return '| ' + cells.map((c) => c.trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
}

/**
 * 判断单元格是否为“干净”的抖音短链接（整格仅一个链接，无多余文字）
 */
function findCleanDouyinUrlCells(cells) {
  const re = /^https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?$/;
  const idxs = [];
  cells.forEach((c, i) => {
    if (re.test(c.trim())) idxs.push(i);
  });
  return idxs;
}

/**
 * 修复因单元格内含字面 `|` 而错位的数据行。
 * 错位后单元格数多于表头（每个 `|` 多拆一列），列序为：
 * [序号, 分类, 标题…(被拆开), 链接, 完整链接…(被拆开)]
 * 通过唯一“干净短链”单元格定位 链接 列，再向两侧拼回标题与完整链接。
 * 修复失败返回 null（例如源列缺失/链接被截断，无法还原）。
 */
function repairMisalignedRow(rowCells, headers) {
  const m = headers.length;
  const n = rowCells.length;
  // 仅支持标准 5 列表（序号 | 分类 | url标题 | 链接 | 完整链接）的错位修复
  if (m !== 5) return null;
  // 只有“多拆出来列”的行才是错位行；占位/空行不处理
  if (n <= m) return null;

  const urlIdxs = findCleanDouyinUrlCells(rowCells);
  // 必须恰好定位到一个干净的链接单元格，否则无法确定列边界
  if (urlIdxs.length !== 1) return null;

  const li = urlIdxs[0];
  if (li < 2) return null;

  // 第 2 列应为 分类列：未分类/空 或含 <code> 标签
  const cat = (rowCells[1] || '').trim();
  const catOk = cat === '' || cat === '未分类' || cat.includes('<code>');
  if (!catOk) return null;

  const repaired = new Array(m).fill('');
  repaired[0] = (rowCells[0] || '').trim(); // 序号
  repaired[1] = cat; // 分类
  repaired[2] = rowCells
    .slice(2, li) // 标题（还原被拆开的 |）
    .map((c) => c.trim())
    .join(' | ');
  repaired[3] = rowCells[li].trim(); // 链接
  repaired[4] = rowCells
    .slice(li + 1) // 完整链接（还原被拆开的 |）
    .map((c) => c.trim())
    .join(' | ');

  return repaired;
}

/**
 * 抖音分享文本前缀中的“噪音” token（时间/日期/分享码/@提及等）
 * 这些 token 不含汉字，不属于标题内容。
 */
const NOISE_TOKEN =
  /^(?::\d+[ap]m|\d{1,2}\/\d{1,2}|[A-Za-z0-9]{1,5}[:@][A-Za-z0-9@.:/\-]{1,8}|#|[:@/]+|[\u3000-\u303F\uFF00-\uFFEF\u2010-\u2027\u2018\u2019\u201C\u201D#@:/]+)$/i;

/**
 * 判断 token 是否为分享码噪音（应被丢弃）
 */
function isNoiseToken(token) {
  if (!token) return true;
  return NOISE_TOKEN.test(token) || /^@\S+$/.test(token);
}

/**
 * 判断 token 是否含有“有意义”内容（任意文字字符、汉字或 emoji，可作为标题起点）
 */
function isMeaningfulToken(token) {
  return /\p{L}/u.test(token) || /\p{Extended_Pictographic}/u.test(token);
}

/**
 * 从抖音分享文本中精准提取纯净标题
 *  1. 去掉尾随噪音（复制提示、短链接）
 *  2. 去掉开头的版本号（如 8.20）
 *  3. 丢弃分享码噪音 token，直到首个有意义 token（汉字/emoji/常规词）
 *  4. 截取到首个 # 之前作为标题
 */
function extractCleanTitle(text) {
  if (!text) return '';

  let core = text
    .replace(/\s*复制此链接[\s\S]*$/, '')
    .replace(/https?:\/\/v\.douyin\.com\/[^\s]*/g, ' ')
    .trim();

  core = core.replace(/^\s*\d+\.\d+\s*/, ' ').trim();

  const tokens = core.split(/\s+/);
  let begin = 0;
  while (begin < tokens.length) {
    const token = tokens[begin];
    // 先丢弃明确的分享码噪音 token（时间/日期/分享码/@提及/纯标点等）
    if (isNoiseToken(token)) {
      begin++;
      continue;
    }
    // 遇到首个“有意义”token（文字/汉字/emoji）即视为标题起点
    if (isMeaningfulToken(token)) break;
    // 纯数字等既非噪音也非文字的内容（如 “2024 年度”），同样视为标题起点
    break;
  }
  core = tokens.slice(begin).join(' ').trim();

  const titleMatch = core.match(/^([\s\S]*?)(?=\s*#|$)/);
  let title = titleMatch ? titleMatch[1] : '';

  // 清理头尾非文字/数字的噪音（保留任意语言的文字与数字）
  // 尾部的闭合括号若与内容中的左括号配对则保留（避免 `…（视频编辑：冯杨）` 被截成 `…（视频编辑：冯杨`）
  title = title.replace(/^[^\p{L}\p{N}_]+/u, '');
  title = title.replace(/[^\p{L}\p{N}_]+$/u, (m) => {
    const lead = m.trimEnd();
    if (!lead) return '';
    const closer = lead.slice(-1);
    const openers = {
      '）': '（',
      '】': '【',
      '」': '「',
      '〉': '〈',
      '》': '《',
      '>': '<',
      ']': '[',
      '}': '{',
    };
    const opener = openers[closer];
    if (opener && title.slice(0, title.length - m.length).includes(opener)) {
      return closer;
    }
    return '';
  });
  title = title.replace(/\s+/g, ' ').trim();

  return title;
}

/**
 * 截断超长行，便于 dry-run 预览输出
 */
function truncateLine(line, maxLen = 120) {
  return line.length > maxLen ? `${line.slice(0, maxLen)}...` : line;
}

/**
 * 🔥 核心优化：精准提取抖音信息
 */
function extractDouyinInfo(text) {
  if (!text) return null;

  // 1. 提取抖音短链接
  const linkRegex = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9\-_\/]+/g;
  const links = text.match(linkRegex) || [];
  const shortLink = links[0] || '';

  if (!shortLink) return null;

  // 2. 提取 #标签
  //    - 标签不跨 `|`（分享文本常用 `#话题|描述` 分隔）
  //    - 含逗号/句号等语句标点，或 `！？` 出现在非结尾处的片段实为描述而非标签，剔除
  const tagRegex = /#\s*([^\s#|]+)/g;
  const hasJunkPunct = (t) => /[，。；、…：]/.test(t) || /[！？]/.test(t.slice(0, -1));
  const tags = [...text.matchAll(tagRegex)]
    .map((m) => m[1].trim())
    .filter((t) => t && !hasJunkPunct(t) && !/^https?:\/\//i.test(t));
  const categoryHtml = tags.length > 0 ? tags.map((t) => `<code>${t}</code>`).join(' ') : '未分类';

  // 3. 精准提取纯净标题
  let title = extractCleanTitle(text);

  // 智能截断
  if (title.length > 40) {
    const punctIdx = title.search(/[，。！？、]/);
    title =
      punctIdx > 0 && punctIdx < 40 ? title.slice(0, punctIdx + 1) : title.slice(0, 40) + '...';
  }

  return {
    shortLink,
    allLinks: links,
    title: title || '无标题',
    tags,
    category: categoryHtml,
  };
}

/**
 * 判断一行是否是表格分隔线
 */
function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  const inner = trimmed.slice(1, -1);
  return /^[\s\-:|]+$/.test(inner);
}

/**
 * 解析 Markdown 中的所有表格
 */
function findAllTables(content) {
  const lines = content.split('\n');
  const tables = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isSeparatorLine(line)) {
      let headerIdx = i - 1;
      while (headerIdx >= 0 && !lines[headerIdx].trim().startsWith('|')) {
        headerIdx--;
      }

      if (headerIdx < 0 || headerIdx !== i - 1) {
        i++;
        continue;
      }

      const headerLine = lines[headerIdx];

      let dataEndIdx = i + 1;
      while (dataEndIdx < lines.length && lines[dataEndIdx].trim().startsWith('|')) {
        if (isSeparatorLine(lines[dataEndIdx])) break;
        dataEndIdx++;
      }

      const headers = parseTableRow(headerLine);
      const tableRows = [];

      for (let j = i + 1; j < dataEndIdx; j++) {
        const rowLine = lines[j].trim();
        if (!rowLine.startsWith('|')) continue;

        const cells = parseTableRow(rowLine);
        // 允许单元格数量略多于表头（防止因分割错误导致错位，但通常应一致）
        // 这里严格匹配长度以确保映射正确
        if (cells.length === headers.length) {
          const rowObj = {};
          headers.forEach((h, idx) => (rowObj[h.trim()] = cells[idx] || ''));
          rowObj._lineIndex = j;
          rowObj._cells = cells;
          rowObj._misaligned = false;
          tableRows.push(rowObj);
        } else if (cells.length > headers.length) {
          // 单元格内含字面 `|` 导致的错位行：先记录，交给 repairMisalignedRow 尝试还原
          const rowObj = { _lineIndex: j, _cells: cells, _misaligned: true };
          tableRows.push(rowObj);
        }
      }

      if (tableRows.length > 0) {
        tables.push({
          headers,
          rows: tableRows,
          startLineIndex: headerIdx,
          endLineIndex: dataEndIdx - 1,
          originalLines: lines,
        });
      }

      i = dataEndIdx;
    } else {
      i++;
    }
  }

  return tables;
}

/**
 * 处理单个文件：读取 -> 解析 -> 填充 -> 加序号 -> 写回
 */
function fillBlogTable(filePath, outputPath = null, config = {}) {
  const defaultConfig = {
    sourceCol: '完整链接', // 源数据列名
    seqCol: '序号', // 序号列名
    targetCols: {
      // 目标列名映射
      分类: 'category',
      url标题: 'title',
      链接: 'shortLink',
    },
    addSeqIfMissing: true, // 如果表中没有序号列，是否自动添加
  };

  const cfg = { ...defaultConfig, ...config };
  const dryRun = !!cfg.dryRun;

  if (!fs.existsSync(filePath)) {
    console.error(`❌ 文件不存在: ${filePath}`);
    return null;
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const { data: frontmatter, content: body, emptySeparator } = matter(fileContent);

  // 1. 查找所有表格
  const tables = findAllTables(body);

  if (tables.length === 0) {
    // console.warn(`⚠️ [${path.basename(filePath)}] 未找到有效表格`);
    return { filledCount: 0, skipped: true };
  }

  let totalFilledCount = 0;
  const changes = [];
  const bodyLines = body.split('\n');

  // 2. 遍历每个表格
  tables.forEach((table, tableIdx) => {
    const { headers, rows } = table;

    // --- 步骤 A: 处理序号列 ---
    let seqColIndex = headers.indexOf(cfg.seqCol);
    let hasSeqCol = seqColIndex !== -1;

    // 如果需要添加序号列且当前没有
    if (!hasSeqCol && cfg.addSeqIfMissing) {
      // 1. 修改表头：在最前面插入 "序号"
      const newHeaders = [cfg.seqCol, ...headers];
      const oldHeaderLine = bodyLines[table.startLineIndex];
      bodyLines[table.startLineIndex] = buildTableRow(newHeaders);
      if (oldHeaderLine !== bodyLines[table.startLineIndex]) {
        changes.push({
          line: table.startLineIndex,
          oldLine: oldHeaderLine,
          newLine: bodyLines[table.startLineIndex],
        });
      }

      // 2. 修改分隔线：在最前面插入 "---"
      // 找到对应的分隔线行 (startLineIndex + 1)
      const sepLineIdx = table.startLineIndex + 1;
      if (sepLineIdx < bodyLines.length && isSeparatorLine(bodyLines[sepLineIdx])) {
        const oldSepCells = parseTableRow(bodyLines[sepLineIdx]);
        const newSepCells = ['---', ...oldSepCells];
        const oldSepLine = bodyLines[sepLineIdx];
        bodyLines[sepLineIdx] = buildTableRow(newSepCells);
        if (oldSepLine !== bodyLines[sepLineIdx]) {
          changes.push({
            line: sepLineIdx,
            oldLine: oldSepLine,
            newLine: bodyLines[sepLineIdx],
          });
        }
      }

      // 3. 更新内存中的 headers 引用，以便后续逻辑使用新的索引
      // 注意：此时 bodyLines 已经改变，但 table.headers 还是旧的，我们需要手动维护逻辑
      // 为了简化，我们重新计算索引，或者在后续循环中动态调整

      // 标记已添加，并更新局部变量
      hasSeqCol = true;
      seqColIndex = 0; // 新加的在第一列

      // 重要：因为我们在 bodyLines 中插入了列，现有的 row._cells 需要扩容
      // 但更简单的方法是：我们在生成最终行字符串时，手动拼接序号
    }

    // --- 步骤 B: 确定源列和目标列索引 ---
    // 如果刚才添加了序号列，headers 数组在内存中没变，但实际文件变了。
    // 为了稳健，我们基于当前的 headers (原始解析的) 来查找源列。
    // 如果添加了序号列，源列的实际物理索引会 +1。

    const sourceColIndexInHeader = headers.indexOf(cfg.sourceCol);
    if (sourceColIndexInHeader === -1) {
      // console.log(`ℹ️ 跳过表格: 缺少源列 [${cfg.sourceCol}]`);
      return;
    }

    // 计算实际在 bodyLines 行中的索引
    // 如果添加了序号列，所有原有列的索引都 +1
    const offset =
      hasSeqCol && cfg.addSeqIfMissing && seqColIndex === 0 && headers.indexOf(cfg.seqCol) === -1
        ? 1
        : 0;
    const actualSourceIdx = sourceColIndexInHeader + offset;

    let tableFilledCount = 0;
    let currentSeq = 1; // 序号计数器

    for (const row of rows) {
      // 处理因字面 `|` 错位的行：尝试还原为标准列结构，失败则跳过该行
      if (row._misaligned) {
        const repaired = repairMisalignedRow(row._cells, headers);
        if (!repaired) continue;
        row._cells = repaired;
        row._misaligned = false;
        headers.forEach((h, idx) => {
          row[h] = repaired[idx] || '';
        });
      }

      // 获取源文本
      // 注意：row._cells 是解析时的旧数据。如果表结构变了（加了列），row._cells 长度不对。
      // 最安全的方式：直接从 bodyLines 重新解析该行，或者依赖 row._cells 并在输出时修正。
      // 鉴于我们只修改内容不删除行，且只在头部加列，我们可以这样处理：

      let fullText = '';
      if (offset === 0) {
        fullText = row[cfg.sourceCol] || '';
      } else {
        // 如果加了列，row 对象里的 key 还是旧的 header name，所以可以直接用 key 取值
        fullText = row[cfg.sourceCol] || '';
      }

      if (!fullText.trim()) {
        // 空行不参与序号计数，保持原样
        continue;
      }

      const info = extractDouyinInfo(fullText);
      if (!info) {
        // 无法提取抖音信息的行不参与序号计数，保持原样
        continue;
      }

      // 构建新行单元格
      // 1. 获取原始单元格副本
      let newCells = [...row._cells];

      // 2. 如果之前添加了序号列，需要在数组最前面插入序号
      if (offset === 1) {
        newCells.unshift(String(currentSeq));
      } else if (hasSeqCol) {
        // 如果原本就有序号列，更新它
        newCells[seqColIndex] = String(currentSeq);
      }

      // 3. 填充其他目标列
      // 注意：如果 offset=1，目标列的物理索引也要 +1
      for (const [targetHeader, fieldKey] of Object.entries(cfg.targetCols)) {
        const targetIdxInHeader = headers.indexOf(targetHeader);
        if (targetIdxInHeader === -1) continue;
        const actualTargetIdx = targetIdxInHeader + offset;
        const existingVal =
          actualTargetIdx < newCells.length ? newCells[actualTargetIdx] || '' : '';

        // 保护人工/既有标题：源里没有可提取标题时不覆盖已有非空标题
        if (fieldKey === 'title' && info.title === '无标题' && existingVal.trim()) {
          continue;
        }

        if (info[fieldKey]) {
          // 确保数组长度足够（防止越界，虽然理论上应该一致）
          if (actualTargetIdx < newCells.length) {
            newCells[actualTargetIdx] = info[fieldKey];
          }
        }
      }

      // 4. 更新行
      const oldLine = bodyLines[row._lineIndex];
      bodyLines[row._lineIndex] = buildTableRow(newCells);
      if (oldLine !== bodyLines[row._lineIndex]) {
        changes.push({ line: row._lineIndex, oldLine, newLine: bodyLines[row._lineIndex] });
      }

      tableFilledCount++;
      currentSeq++;
    }

    totalFilledCount += tableFilledCount;
  });

  if (totalFilledCount === 0) {
    return { filledCount: 0, skipped: true };
  }

  // 3. 写回文件
  const newBody = bodyLines.join('\n');
  const newContent = matter.stringify(newBody, frontmatter, {
    delimiters: emptySeparator ? ['---', '---'] : undefined,
  });

  const targetPath = outputPath || filePath; // 默认覆盖原文件，或者你可以改为 .filled.md
  if (dryRun) {
    return { filledCount: totalFilledCount, outputPath: targetPath, dryRun: true, changes };
  }
  fs.writeFileSync(targetPath, newContent, 'utf-8');

  return { filledCount: totalFilledCount, outputPath: targetPath, dryRun: false, changes };
}

/**
 * 递归获取目录下所有 .md 文件
 */
function getAllMdFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(function (file) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllMdFiles(fullPath, arrayOfFiles);
    } else {
      if (file.endsWith('.md')) {
        arrayOfFiles.push(fullPath);
      }
    }
  });

  return arrayOfFiles;
}

/**
 * 主入口：处理文件或文件夹
 */
function main() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes('--dry-run') || rawArgs.includes('-n');
  const args = rawArgs.filter((a) => a !== '--dry-run' && a !== '-n');
  const targetPath = args[0] || '../博客/'; // 默认当前目录下的 ../博客/ 文件夹或文件
  const customOutputDir = args[1]; // 可选：指定输出目录，如果不指定则覆盖原文件

  if (!fs.existsSync(targetPath)) {
    console.error(`❌ 路径不存在: ${targetPath}`);
    process.exit(1);
  }

  const stats = fs.statSync(targetPath);
  let filesToProcess = [];

  if (stats.isDirectory()) {
    console.log(`📂 扫描目录: ${targetPath}`);
    filesToProcess = getAllMdFiles(targetPath);
  } else {
    filesToProcess = [targetPath];
  }

  if (filesToProcess.length === 0) {
    console.log('ℹ️ 没有找到任何 .md 文件');
    return;
  }

  console.log(`🚀 开始处理 ${filesToProcess.length} 个文件...\n`);

  let totalGlobalFilled = 0;
  let successCount = 0;
  let skipCount = 0;
  let totalChanges = 0;

  filesToProcess.forEach((filePath, index) => {
    console.log(`[${index + 1}/${filesToProcess.length}] 处理: ${path.basename(filePath)}`);

    let outPath = filePath;
    if (customOutputDir) {
      // 如果指定了输出目录，保持相对路径结构
      const relativePath = path.relative(path.dirname(targetPath), filePath);
      outPath = path.join(customOutputDir, relativePath);
      // 确保输出目录存在
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
    }

    try {
      const result = fillBlogTable(filePath, outPath, { dryRun });
      if (result && !result.skipped) {
        totalGlobalFilled += result.filledCount;
        successCount++;
        console.log(`   ✅ 完成: 填充 ${result.filledCount} 行\n`);
        if (result.dryRun) {
          totalChanges += result.changes.length;
          if (result.changes.length === 0) {
            console.log('   • 无变更\n');
          } else {
            console.log(`   💡 dry-run 预览: ${result.changes.length} 行将变化`);
            result.changes.forEach((c) => {
              console.log(`      L${c.line + 1} 旧: ${truncateLine(c.oldLine)}`);
              console.log(`         新: ${truncateLine(c.newLine)}`);
            });
            console.log('');
          }
        }
      } else {
        skipCount++;
        console.log(`   ⏭️  跳过: 无有效数据或表格\n`);
      }
    } catch (err) {
      console.error(`   ❌ 失败: ${err.message}`);
    }
  });

  console.log('\n========================================');
  console.log(`🎉 全部任务结束！`);
  console.log(`📊 统计: 成功 ${successCount} 个文件, 跳过 ${skipCount} 个文件`);
  console.log(`📝 总共填充行数: ${totalGlobalFilled}`);
  if (dryRun) {
    console.log(`💡 DRY-RUN 模式: 未写入任何文件（将变更 ${totalChanges} 行）`);
  } else if (customOutputDir) {
    console.log(`💾 输出目录: ${customOutputDir}`);
  } else {
    console.log(`💾 模式: 覆盖原文件`);
  }
  console.log('========================================');
}

// 执行
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error('❌ 程序异常:', err);
    process.exit(1);
  }
}

export { fillBlogTable, extractDouyinInfo };
