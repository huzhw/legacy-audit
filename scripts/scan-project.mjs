// legacy-audit · 级联调度
// 读 skill 内的 projects.json（一份配置管全部项目）→ 逐项目逐组逐仓扫描 → 基线比对 → 汇总
// 用法：
//   node scan-project.mjs                              扫全部项目
//   node scan-project.mjs --project 档案V6              只扫某项目（支持中文名或序号）
//   node scan-project.mjs --only lanxum-amisp-java     只扫指定仓（逗号分隔）
//   node scan-project.mjs --update-baseline            把当前全部问题记为基线
//   node scan-project.mjs --out <目录>                  报告输出根目录
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const argv = process.argv.slice(2)

const cfgIdx = argv.indexOf('--config')
const cfgFile = cfgIdx >= 0 ? argv[cfgIdx + 1] : path.join(HERE, 'projects.json')
const outIdx = argv.indexOf('--out')
const projIdx = argv.indexOf('--project')
const onlyIdx = argv.indexOf('--only')
const updateBaseline = argv.includes('--update-baseline')
// 首扫时是否把全量历史债当作「新增」报出来。默认否：老项目不查，首次静默建档。
const reportFirstRun = argv.includes('--report-first-run')
// 增量范围：只查某时间点之后改动的文件（如 --changed-since 2026-11-02）
const changedSince = argVal('--changed-since')
const changedAuthor = argVal('--changed-author')

function argVal(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

const projFilter = projIdx >= 0 ? argv[projIdx + 1] : null
const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(',').map(s => s.trim())) : null

const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
const projects = (cfg.projects || []).filter(p => !projFilter || p.project === projFilter || p.root === projFilter)
if (!projects.length) {
  console.error('未匹配到项目。可用项目：')
  for (const p of cfg.projects || []) console.error('  - ' + p.project)
  process.exit(2)
}

const repoResults = []
const errors = []
const projectOutDirs = {}   // project -> 报告目录（供结尾汇总打印）

for (const proj of projects) {
  const projectRoot = proj.root
  const exclude = new Set(proj.exclude || [])
  // 报告写到**项目自己目录**下（<项目根>/.legacy-audit/report/），看完不用跨仓找；
  // 该目录已在各业务仓 .gitignore 排除。显式 --out 才会覆盖。
  // 报告落点优先级：--out > 配置里的 reportDir（相对项目根）> <项目根>/.legacy-audit/report
  // root 本身可能是工作区（多项目父目录），所以允许 reportDir 指到主仓子目录
  const outRoot = outIdx >= 0
    ? path.join(argv[outIdx + 1], proj.project)
    : (proj.reportDir ? path.join(projectRoot, proj.reportDir)
                      : path.join(projectRoot, '.legacy-audit', 'report'))
  projectOutDirs[proj.project] = outRoot
  fs.mkdirSync(outRoot, { recursive: true })

  console.log('\n' + '='.repeat(70))
  console.log(`项目：${proj.project}`)
  console.log(`根：  ${projectRoot}`)
  console.log('='.repeat(70))

  // 项目级排除规则写成临时文件（第二层），与 skill 通用层、仓级 ignore.txt 合并
  let projectIgnoreFile = null
  if (proj.ignore && proj.ignore.length) {
    projectIgnoreFile = path.join(outRoot, '_project-ignore.json')
    fs.writeFileSync(projectIgnoreFile, JSON.stringify({ ignore: proj.ignore }), 'utf8')
  }

  for (const group of proj.groups || []) {
    for (const entry of group.repos || []) {
      const repoName = typeof entry === 'string' ? entry : entry.dir
      const cn = typeof entry === 'string' ? entry : (entry.cn || entry.dir)
      if (exclude.has(repoName)) continue
      if (only && !only.has(repoName)) continue
      const repoPath = path.join(projectRoot, repoName)
      if (!fs.existsSync(repoPath)) {
        errors.push({ project: proj.project, repo: repoName, error: '目录不存在: ' + repoPath })
        continue
      }
      const repoOut = path.join(outRoot, repoName)
      console.log(`\n[扫描] ${group.name} / ${repoName}（${cn}）`)
      const repoArgs = [path.join(HERE, 'scan-repo.mjs'), repoPath, repoName, repoOut]
      if (projectIgnoreFile) repoArgs.push('--project-ignore', projectIgnoreFile)
      if (changedSince) repoArgs.push('--changed-since', changedSince)
      if (changedAuthor) repoArgs.push('--changed-author', changedAuthor)
      try {
        execFileSync('node', repoArgs, { stdio: 'inherit', encoding: 'utf8' })
      } catch (e) {
        errors.push({ project: proj.project, repo: repoName, error: '扫描失败: ' + String(e.message || e).slice(0, 200) })
        continue
      }
      // 基线比对（基线存各仓自己目录，随仓走）
      const findingsFile = path.join(repoOut, 'findings.json')
      const baselineFile = path.join(repoPath, '.legacy-audit', 'baseline.json')
      if (!fs.existsSync(findingsFile)) continue

      // 老项目不查：仓里还没有基线时，首次扫描**自动建档并视为存量**，不把几万条历史债
      // 当成"新增"报出来。想真看首扫全量，用 --report-first-run。
      const firstRunAutoBaseline = !fs.existsSync(baselineFile)
      if (firstRunAutoBaseline) {
        try {
          execFileSync('node', [path.join(HERE, 'baseline.mjs'), 'build',
            findingsFile, baselineFile, repoPath], { encoding: 'utf8' })
          console.log(`  [首扫建档] 基线已写入 .legacy-audit/baseline.json，历史债不计入新增`)
        } catch (e) {
          errors.push({ project: proj.project, repo: repoName, error: '首扫建档失败: ' + String(e.message || e).slice(0, 200) })
          continue
        }
      }

      let diff
      try {
        diff = JSON.parse(execFileSync('node', [path.join(HERE, 'baseline.mjs'), 'diff',
          findingsFile, baselineFile, repoPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
      } catch (e) {
        errors.push({ project: proj.project, repo: repoName, error: '基线比对失败: ' + String(e.message || e).slice(0, 200) })
        continue
      }
      // 首扫自动建档的情况下，除非显式要首扫全量，否则不报"新增"
      if (firstRunAutoBaseline && !reportFirstRun) {
        diff.added = []
        diff.firstRun = false
      }
      if (updateBaseline && !firstRunAutoBaseline) {
        execFileSync('node', [path.join(HERE, 'baseline.mjs'), 'build',
          findingsFile, baselineFile, repoPath], { stdio: 'inherit' })
      }
      const all = JSON.parse(fs.readFileSync(findingsFile, 'utf8'))
      repoResults.push({
        project: proj.project, group: group.name, repo: repoName, cn, repoPath,
        total: all.findings.length, counts: all.counts,
        firstRun: diff.firstRun || false, added: diff.added || [], fixedCount: diff.fixedCount || 0,
      })
    }
  }

  // ---- 项目级汇总 ----
  const mine = repoResults.filter(r => r.project === proj.project)
  const summary = {
    project: proj.project, root: projectRoot, generatedAt: new Date().toISOString(),
    repoCount: mine.length,
    totalFindings: mine.reduce((a, r) => a + r.total, 0),
    totalNew: mine.reduce((a, r) => a + r.added.length, 0),
    byGroup: {}, byTool: {},
    repos: mine.map(r => ({
      group: r.group, repo: r.repo, cn: r.cn, total: r.total, new: r.added.length,
      fixed: r.fixedCount, counts: r.counts, firstRun: r.firstRun,
    })),
    errors: errors.filter(e => e.project === proj.project),
  }
  for (const r of mine) {
    summary.byGroup[r.group] = (summary.byGroup[r.group] || 0) + r.total
    for (const [k, v] of Object.entries(r.counts || {})) summary.byTool[k] = (summary.byTool[k] || 0) + v
  }
  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8')

  console.log('\n---------- 项目汇总 ----------')
  console.log('报告目录:', outRoot)
  console.log('仓库数:', summary.repoCount, ' 总问题:', summary.totalFindings, ' 新增:', summary.totalNew)
  console.log('按工具:', JSON.stringify(summary.byTool))
  console.log('按子项目组:')
  for (const [g, n] of Object.entries(summary.byGroup).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + g.padEnd(16) + n)
  }
  console.log('各仓:')
  for (const r of summary.repos.sort((a, b) => b.total - a.total)) {
    console.log(`  ${String(r.total).padStart(6)}  ${r.repo.padEnd(30)} ${r.cn || ''}${r.firstRun ? ' [首扫]' : ''}`)
  }
  if (summary.errors.length) {
    console.log('错误:')
    for (const e of summary.errors) console.log('  ' + e.repo + ': ' + e.error)
  }
}

// 全局汇总（多项目时）
if (projects.length > 1) {
  console.log('\n' + '#'.repeat(70))
  console.log('全部项目汇总')
  console.log('#'.repeat(70))
  const all = {}
  for (const proj of projects) {
    const summaryFile = path.join(defaultOutRoot, proj.project, 'summary.json')
    if (!fs.existsSync(summaryFile)) continue
    const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    all[proj.project] = { repos: s.repoCount, total: s.totalFindings, new: s.totalNew }
  }
  for (const [p, v] of Object.entries(all)) {
    console.log(`  ${p.padEnd(16)} ${String(v.repos).padStart(3)} 仓  ${String(v.total).padStart(7)} 条  新增 ${v.new}`)
  }
}
