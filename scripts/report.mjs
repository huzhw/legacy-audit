// legacy-audit · 报告生成
// 职责：读 summary.json + 各仓 findings → 按四档分级 → 出 Markdown 表（可粘进债务清单）
// 用法：node report.mjs <reportDir> [out.md]
import fs from 'node:fs'
import path from 'node:path'

const argDir = process.argv[2]
const allMode = process.argv.includes('--all')
const targets = []
if (allMode) {
  // 遍历输出根下每个项目子目录（含 summary.json 的）
  for (const d of fs.readdirSync(argDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const p = path.join(argDir, d.name)
    if (fs.existsSync(path.join(p, 'summary.json'))) targets.push(p)
  }
} else {
  targets.push(argDir)
}
for (const reportDir of targets) {
  const outFile = process.argv[3] && !allMode ? process.argv[3] : path.join(reportDir, 'report.md')
  genOne(reportDir, outFile)
}

function genOne(reportDir, outFile) {
const summary = JSON.parse(fs.readFileSync(path.join(reportDir, 'summary.json'), 'utf8'))

// ---- 分级规则（与 references/grading.md 一致）----
const P0 = {
  pmd: ['GodClass', 'ExcessiveMethodLength', 'ExcessiveClassLength', 'CognitiveComplexity', 'CyclomaticComplexity'],
  checkstyle: ['MethodLength', 'FileLength', 'ClassFanOutComplexity', 'NestedIfDepth', 'ExecutableStatementCount'],
  ruff: ['C901', 'PLR0912', 'PLR0915'],
  eslint: ['complexity', 'max-statements'],
}
const P1 = {
  pmd: ['EmptyCatchBlock'],
  spotbugs: ['UPM_UNCALLED_PRIVATE_METHOD', 'DLS_DEAD_LOCAL_STORE',
    'SQL_PREPARED_STATEMENT_GENERATED_FROM_NONCONSTANT_STRING', 'DM_DEFAULT_ENCODING'],
  ruff: ['BLE001'],
  eslint: ['no-empty'],
  checkstyle: ['IllegalCatch', 'IllegalThrows'],
  clippy: [],
}
const P2 = {
  pmd: ['AvoidDuplicateLiterals', 'DataflowAnomalyAnalysis'],
  checkstyle: ['MultipleStringLiterals'],
  ruff: ['PLR2004'],
}
const P3 = {
  pmd: ['UnusedImports', 'UnusedAssignment'],
  checkstyle: ['UnusedImports', 'UnusedLocalVariable', 'RedundantImport'],
  eslint: ['no-unused-vars', 'prefer-const', 'no-var'],
  ruff: ['ARG001', 'ARG002'],
}

function grade(f) {
  for (const [g, map] of [['P0', P0], ['P1', P1], ['P2', P2], ['P3', P3]]) {
    const rules = map[f.tool] || []
    if (rules.includes(f.rule)) return g
  }
  // jscpd 复制族按行数分档
  if (f.tool === 'jscpd') {
    const n = f.lines || 0
    if (n >= 50) return 'P0'
    return 'P2'
  }
  // radon 按评级
  if (f.tool === 'radon') {
    const g = f.grade
    if (g === 'D' || g === 'E' || g === 'F') return 'P0'
    if (g === 'C') return 'P2'
    return 'P3'
  }
  return 'P3'
}

// ---- 收集 ----
const all = []
for (const r of summary.repos || []) {
  const f = path.join(reportDir, r.repo, 'findings.json')
  if (!fs.existsSync(f)) continue
  const d = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const x of d.findings || []) all.push({ ...x, repo: r.repo, cn: r.cn, group: r.group })
}

const graded = all.map(f => ({ ...f, grade: grade(f) }))
const counts = { P0: 0, P1: 0, P2: 0, P3: 0 }
for (const g of graded) counts[g.grade]++

// ---- 按仓库聚合（同一文件同规则只留一条，代表性最强）----
const byFile = new Map()
for (const g of graded) {
  const key = `${g.repo}|${g.grade}|${g.file}|${g.rule}`
  const prev = byFile.get(key)
  if (!prev || (g.message || '').length > (prev.message || '').length) byFile.set(key, g)
}
const rows = [...byFile.values()]

// 复制族单独成条（一个克隆对一条，不按文件拆）
const cloneRows = []
const seenClone = new Set()
for (const g of graded) {
  if (g.tool !== 'jscpd') continue
  const key = `${g.repo}|${g.file}|${g.cloneOf}`
  if (seenClone.has(key)) continue
  seenClone.add(key)
  cloneRows.push(g)
}

// ---- 输出 ----
const L = []
L.push(`# 屎山体检报告 · ${summary.project}`)
L.push('')
L.push(`**生成时间：** ${summary.generatedAt}`)
L.push(`**仓库数：** ${summary.repoCount}　**问题总数：** ${summary.totalFindings}　**相对基线新增：** ${summary.totalNew}`)
L.push('')
L.push('## 分级总览')
L.push('')
L.push('| 档位 | 含义 | 数量 |')
L.push('|---|---|---|')
L.push(`| P0 结构性 | 上帝类 / 超长方法 / 高复杂度 / 复制族 | ${counts.P0} |`)
L.push(`| P1 风险性 | 死代码 / 吞异常 / SQL 拼接 | ${counts.P1} |`)
L.push(`| P2 重复 | 重复字面量 / 魔法值 | ${counts.P2} |`)
L.push(`| P3 卫生 | 未用变量 / 未用 import | ${counts.P3} |`)
L.push('')
L.push('## 各仓概览')
L.push('')
L.push('| 子项目组 | 仓库 | 中文名 | 问题总数 | P0 | P1 | P2 | P3 |')
L.push('|---|---|---|---|---|---|---|---|')
for (const r of summary.repos.slice().sort((a, b) => b.total - a.total)) {
  const fs2 = graded.filter(x => x.repo === r.repo)
  const c = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const x of fs2) c[x.grade]++
  L.push(`| ${r.group} | ${r.repo} | ${r.cn || ''} | ${r.total} | ${c.P0} | ${c.P1} | ${c.P2} | ${c.P3} |`)
}
L.push('')
L.push('## P0 复制族明细（跨文件 / 跨仓）')
L.push('')
if (cloneRows.length) {
  L.push('| 仓库 | 重复行数 | 文件 A | 文件 B |')
  L.push('|---|---|---|---|')
  for (const c of cloneRows.filter(x => x.lines >= 50).sort((a, b) => b.lines - a.lines).slice(0, 60)) {
    L.push(`| ${c.repo} | ${c.lines} | ${c.file}:${c.line} | ${c.cloneOf}:${c.cloneStart} |`)
  }
} else {
  L.push('（无 ≥50 行的复制族）')
}
L.push('')
L.push('## P0 结构性明细（按文件聚合，TOP 60）')
L.push('')
L.push('| 仓库 | 文件 | 规则 | 说明 |')
L.push('|---|---|---|---|')
const p0 = rows.filter(x => x.grade === 'P0' && x.tool !== 'jscpd')
for (const x of p0.slice(0, 60)) {
  L.push(`| ${x.repo} | ${x.file}:${x.line} | ${x.rule} | ${(x.message || '').replace(/\|/g, '/').slice(0, 80)} |`)
}
L.push('')
L.push('## P1 风险性明细（TOP 60）')
L.push('')
L.push('| 仓库 | 文件 | 规则 | 说明 |')
L.push('|---|---|---|---|')
for (const x of rows.filter(x => x.grade === 'P1').slice(0, 60)) {
  L.push(`| ${x.repo} | ${x.file}:${x.line} | ${x.rule} | ${(x.message || '').replace(/\|/g, '/').slice(0, 80)} |`)
}
L.push('')
L.push('---')
L.push('')
L.push('> 分级口径见 skill 的 `references/grading.md`；工具只报结构事实，定级与排期由人拍板。')
L.push('> 本报告由 `legacy-audit` skill 自动生成，**只报不修**。')

fs.writeFileSync(outFile, L.join('\n') + '\n', 'utf8')
console.log('报告已生成:', outFile)
console.log('分级:', JSON.stringify(counts))
console.log('P0 条目:', p0.length, ' P1 条目:', rows.filter(x => x.grade === 'P1').length,
  ' 复制族(≥50行):', cloneRows.filter(x => x.lines >= 50).length)
}
