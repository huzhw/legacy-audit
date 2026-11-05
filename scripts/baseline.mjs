// legacy-audit · 基线棘轮
// 职责：把 findings 转成指纹、存基线、比对差集（只报新增）、重拍基线
// 指纹口径：tool + 规则 + 相对文件路径 + 问题所在代码片段哈希（**不用行号**，代码移动不误报）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const cmd = argv[0]                       // build | diff | update
const findingsFile = argv[1]             // findings.json 路径
const baselineFile = argv[2]             // baseline.json 路径
const repoRoot = argv[3] || ''

function hashCode(file, line) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    // 取问题行附近 ±2 行做片段，避免空行变动导致指纹漂移
    const idx = Math.max(0, (line || 1) - 3)
    const snippet = lines.slice(idx, idx + 5).join('\n').trim()
    if (!snippet) return ''
    return crypto.createHash('sha1').update(snippet).digest('hex').slice(0, 12)
  } catch { return '' }
}

function rel(file) {
  if (!repoRoot) return file
  const p = file.replace(/\\/g, '/')
  const r = repoRoot.replace(/\\/g, '/')
  return p.startsWith(r) ? p.slice(r.length).replace(/^\//, '') : p
}

function fingerprint(f) {
  const key = [f.tool, f.rule, rel(f.file || ''), hashCode(f.file, f.line)].join('|')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

const data = JSON.parse(fs.readFileSync(findingsFile, 'utf8'))
const items = (data.findings || []).map(f => ({
  fp: fingerprint(f),
  tool: f.tool, rule: f.rule, severity: f.severity,
  file: rel(f.file || ''), line: f.line, message: f.message,
  ...(f.lines ? { lines: f.lines } : {}),
  ...(f.cloneOf ? { cloneOf: rel(f.cloneOf), cloneStart: f.cloneStart } : {}),
}))

if (cmd === 'build' || cmd === 'update') {
  const out = {
    repo: data.repo, builtAt: new Date().toISOString(),
    tools: data.counts || {}, total: items.length, fingerprints: {},
  }
  for (const it of items) out.fingerprints[it.fp] = it
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true })
  fs.writeFileSync(baselineFile, JSON.stringify(out, null, 1), 'utf8')
  console.log(JSON.stringify({ action: cmd, repo: data.repo, baseline: items.length, file: baselineFile }))
  process.exit(0)
}

if (cmd === 'diff') {
  if (!fs.existsSync(baselineFile)) {
    // 没有基线 = 首次；全部算新增
    console.log(JSON.stringify({ repo: data.repo, firstRun: true, new: items.length, items }, null, 1))
    process.exit(0)
  }
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  const known = new Set(Object.keys(base.fingerprints || {}))
  const added = items.filter(i => !known.has(i.fp))
  const fixed = Object.values(base.fingerprints || {}).filter(b => !items.some(i => i.fp === b.fp))
  console.log(JSON.stringify({
    repo: data.repo, firstRun: false,
    total: items.length, newCount: added.length, fixedCount: fixed.length,
    added, fixed: fixed.map(f => ({ tool: f.tool, rule: f.rule, file: f.file, line: f.line })),
  }, null, 1))
  process.exit(0)
}

console.error('用法: baseline.mjs <build|diff|update> <findings.json> <baseline.json> [repoRoot]')
process.exit(2)
