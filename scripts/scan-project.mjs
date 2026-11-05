// legacy-audit · 级联调度
// 职责：读项目配置 legacy-audit.projects.json → 逐组逐仓扫描 → 基线比对 → 汇总报告
// 用法：node scan-project.mjs <projects.json> [--out <dir>] [--update-baseline] [--only <repo,repo>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const argv = process.argv.slice(2)
const cfgFile = argv[0]
const outIdx = argv.indexOf('--out')
const outRoot = outIdx > 0 ? argv[outIdx + 1] : path.join(path.dirname(cfgFile), '.legacy-audit', 'report')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx > 0 ? new Set(argv[onlyIdx + 1].split(',').map(s => s.trim())) : null
const updateBaseline = argv.includes('--update-baseline')

const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
const projectRoot = cfg.root
const skillRoot = path.resolve(HERE, '..')
const toolsRoot = path.join(skillRoot, 'tools')
const exclude = new Set(cfg.exclude || [])

fs.mkdirSync(outRoot, { recursive: true })

const repoResults = []
const errors = []

for (const group of cfg.groups || []) {
  for (const repoName of group.repos || []) {
    if (exclude.has(repoName)) continue
    if (only && !only.has(repoName)) continue
    const repoPath = path.join(projectRoot, repoName)
    if (!fs.existsSync(repoPath)) {
      errors.push({ repo: repoName, error: '目录不存在: ' + repoPath })
      continue
    }
    const repoOut = path.join(outRoot, repoName)
    console.log(`\n[扫描] ${group.name} / ${repoName}`)
    try {
      execFileSync('node', [path.join(HERE, 'scan-repo.mjs'), repoPath, repoName, repoOut],
        { stdio: 'inherit', encoding: 'utf8' })
    } catch (e) {
      errors.push({ repo: repoName, error: '扫描失败: ' + String(e.message || e).slice(0, 200) })
      continue
    }
    // 基线比对
    const findingsFile = path.join(repoOut, 'findings.json')
    const baselineFile = path.join(repoPath, '.legacy-audit', 'baseline.json')
    if (!fs.existsSync(findingsFile)) continue
    let diff
    try {
      diff = JSON.parse(execFileSync('node', [path.join(HERE, 'baseline.mjs'), 'diff',
        findingsFile, baselineFile, repoPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
    } catch (e) {
      errors.push({ repo: repoName, error: '基线比对失败: ' + String(e.message || e).slice(0, 200) })
      continue
    }
    if (updateBaseline) {
      execFileSync('node', [path.join(HERE, 'baseline.mjs'), 'build',
        findingsFile, baselineFile, repoPath], { stdio: 'inherit' })
    }
    const all = JSON.parse(fs.readFileSync(findingsFile, 'utf8'))
    repoResults.push({
      group: group.name, repo: repoName, repoPath,
      total: all.findings.length,
      counts: all.counts,
      firstRun: diff.firstRun || false,
      added: diff.added || [],
      fixedCount: diff.fixedCount || 0,
    })
  }
}

// 汇总
const summary = {
  project: cfg.project, generatedAt: new Date().toISOString(),
  repoCount: repoResults.length,
  totalFindings: repoResults.reduce((a, r) => a + r.total, 0),
  totalNew: repoResults.reduce((a, r) => a + r.added.length, 0),
  byGroup: {},
  byTool: {},
  repos: repoResults.map(r => ({
    group: r.group, repo: r.repo, total: r.total, new: r.added.length,
    fixed: r.fixedCount, counts: r.counts, firstRun: r.firstRun,
  })),
  errors,
}
for (const r of repoResults) {
  summary.byGroup[r.group] = (summary.byGroup[r.group] || 0) + r.total
  for (const [k, v] of Object.entries(r.counts || {})) summary.byTool[k] = (summary.byTool[k] || 0) + v
}
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8')

console.log('\n========== 项目汇总 ==========')
console.log('项目:', summary.project)
console.log('仓库数:', summary.repoCount, ' 总问题:', summary.totalFindings, ' 新增:', summary.totalNew)
console.log('\n按工具:', JSON.stringify(summary.byTool))
console.log('\n按子项目组:')
for (const [g, n] of Object.entries(summary.byGroup).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + g.padEnd(16) + n)
}
console.log('\n各仓 TOP:')
for (const r of summary.repos.sort((a, b) => b.total - a.total)) {
  console.log(`  ${String(r.total).padStart(6)}  ${r.repo.padEnd(28)} ${r.group}${r.firstRun ? ' [首扫]' : ''}`)
}
if (errors.length) {
  console.log('\n错误:')
  for (const e of errors) console.log('  ' + e.repo + ': ' + e.error)
}
