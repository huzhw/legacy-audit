// legacy-audit 屎山体检扫描器
// 职责：按仓库画像调用多语言静态分析工具，输出统一 JSON findings
// 用法：node scan-repo.mjs <repoPath> <repoName> <outDir> [--project-ignore <json>]
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TOOLS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools')
const SKILL = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

// 跳过目录：兼容 node_modules0606 / node_modules_backup 等变体
const SKIP_DIRS = ['node_modules', 'target', 'dist', 'build', '.git', '.venv', 'venv', '__pycache__', '.idea', 'out', 'bin', 'obj']
const isSkipped = (n) => SKIP_DIRS.includes(n) || /^node_modules\d*\w*$/.test(n)

// ============ 排除规则分层 ============
// ① 通用层：所有项目共有，写死在 skill 里（构建产物、依赖、文档）
// ② 项目层：从 legacy-audit.projects.json 的 ignore 字段读，该项目所有仓共享
// ③ 仓层：从 <repo>/.legacy-audit/ignore.txt 读，仅该仓生效

const COMMON_IGNORE = [
  '**/node_modules/**', '**/node_modules*/**',
  '**/dist/**', '**/build/**', '**/out/**', '**/target/**', '**/coverage/**', '**/.next/**',
  '**/*.min.js', '**/public/pdf/**', '**/static/js/lib/**',
  '**/vendor/**', '**/vendors/**',
  // 文档重复是模板化写作，不是复制粘贴缺陷
  '**/*.md', '**/*.markdown', '**/*.rst', '**/*.txt',
  '**/docs/**', '**/doc/**',
]

const argv = process.argv.slice(2)
const repoPath = argv[0]
const repoName = argv[1] || path.basename(repoPath)
const outDir = argv[2] || path.join(repoPath, '.legacy-audit', 'out')

// 取参数值：indexOf 为 0 时也算命中（放在第一个参数时不能失效）
function argVal(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}
const incRef = argVal('--incremental')
const projectIgnoreFile = argVal('--project-ignore')
const changedSince = argVal('--changed-since')
const changedAuthor = argVal('--changed-author')

// ============ 增量范围：只查某时间点之后改动的文件 ============
// 老仓库全量扫会出几万条历史债，实际关心的是"这周新写的东西"。
// 传 --changed-since 2026-11-02 后，各工具只在这些文件上跑。
let changedSet = null       // 相对仓根的正斜杠路径集合
if (changedSince) {
  const args = ['log', `--since=${changedSince}`, '--pretty=tformat:@@CH@@', '--name-only']
  if (changedAuthor) args.push(`--author=${changedAuthor}`)
  let out = ''
  try {
    out = execSync(['git', '-c', 'core.quotepath=false', ...args]
      .map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
      { cwd: repoPath, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (e) {
    console.error('[warn] git log 取改动文件失败: ' + String(e.message || e).slice(0, 200))
  }
  const set = new Set()
  for (let line of out.split('\n')) {
    line = line.trim()
    if (!line || line === '@@CH@@') continue
    // git 对含非 ASCII 的路径会加引号并转义，去掉引号
    line = line.replace(/^"|"$/g, '')
    set.add(line.split(path.sep).join('/'))
  }
  changedSet = set
  console.error(`[info] 增量范围：${changedSince} 之后改动 ${set.size} 个文件`)
}

// ② 项目层
let projectIgnore = []
if (projectIgnoreFile && fs.existsSync(projectIgnoreFile)) {
  try {
    const d = JSON.parse(fs.readFileSync(projectIgnoreFile, 'utf8'))
    projectIgnore = Array.isArray(d) ? d : (d.ignore || [])
    if (projectIgnore.length) console.error(`[info] 项目级排除 ${projectIgnore.length} 条`)
  } catch (e) {
    console.error('[warn] 项目级 ignore 解析失败: ' + e.message)
  }
}

// ③ 仓层
const repoIgnoreFile = path.join(repoPath, '.legacy-audit', 'ignore.txt')
let repoIgnore = []
if (fs.existsSync(repoIgnoreFile)) {
  for (const line of fs.readFileSync(repoIgnoreFile, 'utf8').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) repoIgnore.push(t)
  }
  if (repoIgnore.length) console.error(`[info] 仓级排除 ${repoIgnore.length} 条`)
}

// 三层合并（去重）
const ALL_IGNORE = [...new Set([...COMMON_IGNORE, ...projectIgnore, ...repoIgnore])]

fs.mkdirSync(outDir, { recursive: true })

const findings = []
function add(tool, rule, severity, file, line, message, extra) {
  findings.push({ tool, rule, severity, file, line, message, ...(extra || {}) })
}

// Windows 上 mvn/npx 是 .cmd 批处理，必须走 shell（execFileSync 不认 .cmd）
function run(cmd, args, opts = {}) {
  // Windows：mvn/npx 是 .cmd 批处理，需用 cmd /c 调；参数用双引号包裹
  const line = process.platform === 'win32'
    ? 'cmd /c ' + [cmd, ...args].map(a => /\s/.test(String(a)) ? '"' + String(a) + '"' : String(a)).join(' ') + ' 2>&1'
    : [cmd, ...args].join(' ')
  try {
    const o = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts }
    if (o.env) o.env = { ...process.env, ...o.env }
    return execSync(line, o)
  } catch (e) {
    // 扫描类工具（eslint/jscpd/spotbugs）发现问题时会返回非 0，属正常；只要报告文件生成了就不算失败
    const out = (e.stdout || '') + (e.stderr || '')
    if (!opts.tolerateFailure) {
      console.error('[run-fail] ' + cmd + ' :: ' + String(e.message || e).slice(0, 300))
      if (process.env.LEGACY_AUDIT_DEBUG) console.error(out)
    }
    return out
  }
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { return (e.stdout || '') + (e.stderr || '') }
}

// ---------- 探测 ----------
const detect = {
  javaRoots: [], classDirs: [], pyRoots: [], tsRoots: [], rustRoots: [], webRoots: [],
}
function walk(dir, depth, out, maxDepth = 4) {
  if (depth > maxDepth) return
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    if (isSkipped(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.name === 'java' && dir.endsWith('src' + path.sep + 'main')) { detect.javaRoots.push(p); continue }
    if (e.name === 'classes' && dir.endsWith('target')) { detect.classDirs.push(p); continue }
    if (e.name === 'src' && depth <= 2) { walk(p, depth + 1, out); continue }
    walk(p, depth + 1, out, maxDepth)
  }
}
walk(repoPath, 0, null)

// 补探测：显式找 pom/package/pyproject/Cargo
function findFiles(root, names, maxDepth = 4) {
  const res = []
  function rec(d, dp) {
    if (dp > maxDepth) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (isSkipped(e.name)) continue
        rec(path.join(d, e.name), dp + 1)
      } else if (names.includes(e.name)) {
        res.push(path.join(d, e.name))
      }
    }
  }
  rec(root, 0)
  return res
}

const poms = findFiles(repoPath, ['pom.xml'])
const pkgs = findFiles(repoPath, ['package.json'])
const pyprojects = findFiles(repoPath, ['pyproject.toml'])
const cargos = findFiles(repoPath, ['Cargo.toml'])

// ---------- 1) PMD + Checkstyle（Java）----------
const javaRoots = new Set(detect.javaRoots)
for (const p of poms) {
  const base = path.dirname(p)
  const src = path.join(base, 'src', 'main', 'java')
  if (fs.existsSync(src)) javaRoots.add(src)
}
// 增量模式下该仓没有 Java 改动 → 整段跳过 PMD/Checkstyle，不白跑 Maven
const javaRootsChanged = javaRoots.size && changedSet
  ? [...changedSet].some(rel => rel.endsWith('.java'))
  : true
if (javaRoots.size && javaRootsChanged) {
  const work = path.join(outDir, '_mvn')
  fs.mkdirSync(work, { recursive: true })

  // 增量模式：算出改动文件相对各 javaRoot 的路径，给 PMD/Checkstyle 做 includes。
  // 没有改动 Java 文件时整段跳过，不白跑 Maven。
  let javaIncludes = null   // null = 全量；数组 = 仅这些（相对 source root）
  if (changedSet) {
    javaIncludes = []
    for (const rel of changedSet) {
      if (!rel.endsWith('.java')) continue
      for (const root of javaRoots) {
        const abs = path.join(repoPath, rel.split('/').join(path.sep))
        const rootNorm = root.split(path.sep).join('/')
        const absNorm = abs.split(path.sep).join('/')
        if (absNorm.startsWith(rootNorm + '/') && fs.existsSync(abs)) {
          javaIncludes.push(absNorm.slice(rootNorm.length + 1))
          break
        }
      }
    }
    if (!javaIncludes.length) {
      console.error('[info] 增量范围内没有 Java 改动文件，跳过 PMD/Checkstyle')
    } else {
      console.error(`[info] Java 增量文件 ${javaIncludes.length} 个，PMD/Checkstyle 只扫这些`)
    }
  }
  // PMD 插件的 includes 是 List，用嵌套 <include> 元素
  const pmdIncludesXml = javaIncludes && javaIncludes.length
    ? `<includes>\n${javaIncludes.map(f => `            <include>${f}</include>`).join('\n')}\n          </includes>`
    : ''
  // Checkstyle 插件的 includes 是 String[]，只接受逗号分隔的整串，不能嵌套子元素
  const csIncludesXml = javaIncludes && javaIncludes.length
    ? `<includes>${javaIncludes.join(',')}</includes>`
    : ''
  const runnerPom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>local</groupId><artifactId>legacy-audit-runner</artifactId><version>1.0</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.source>1.8</maven.compiler.source>
    <maven.compiler.target>1.8</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <build>
    <sourceDirectory>${[...javaRoots][0]}</sourceDirectory>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-pmd-plugin</artifactId><version>3.21.2</version>
        <configuration>
          <targetJdk>1.8</targetJdk><includeTests>false</includeTests><linkXRef>false</linkXRef>
          <failOnViolation>false</failOnViolation>
          <rulesets><ruleset>${path.join(TOOLS, 'legacy-audit.xml').replace(/\\/g, '/')}</ruleset></rulesets>
          <compileSourceRoots>
${[...javaRoots].map(r => `            <compileSourceRoot>${r.replace(/\\/g, '/')}</compileSourceRoot>`).join('\n')}
          </compileSourceRoots>
          ${pmdIncludesXml}
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-checkstyle-plugin</artifactId><version>3.6.0</version>
        <configuration>
          <configLocation>${path.join(TOOLS, 'checkstyle-legacy.xml').replace(/\\/g, '/')}</configLocation>
          <includeTestSourceDirectory>false</includeTestSourceDirectory>
          <failOnViolation>false</failOnViolation><consoleOutput>false</consoleOutput><linkXRef>false</linkXRef>
          <compileSourceRoots>
${[...javaRoots].map(r => `            <compileSourceRoot>${r.replace(/\\/g, '/')}</compileSourceRoot>`).join('\n')}
          </compileSourceRoots>
          ${csIncludesXml}
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>`
  fs.writeFileSync(path.join(work, 'pom.xml'), runnerPom, 'utf8')
  const pmdOut = path.join(work, 'pmd')
  const csOut = path.join(work, 'cs')
  // PMD 有分析缓存，二次跑会被跳过；每次都清 target 保证真实执行
  fs.rmSync(path.join(work, 'target'), { recursive: true, force: true })
  run('mvn', ['-B', '-Dpmd.analysisCache=false', 'pmd:pmd'], { cwd: work })
  run('mvn', ['-B', '-Dcheckstyle.cache.file=' + path.join(work, 'target', 'cs.cache'), 'checkstyle:checkstyle'], { cwd: work })
  // 插件输出落在 work/target 下
  const pmdXml = path.join(work, 'target', 'pmd.xml')
  const csXml = path.join(work, 'target', 'checkstyle-result.xml')
  parsePmd(pmdXml)
  parseCheckstyle(csXml)
  if (fs.existsSync(pmdXml)) fs.writeFileSync(path.join(outDir, 'pmd-report.xml'), fs.readFileSync(pmdXml, 'utf8'))
  if (fs.existsSync(csXml)) fs.writeFileSync(path.join(outDir, 'checkstyle-report.xml'), fs.readFileSync(csXml, 'utf8'))
}

function parsePmd(file) {
  if (!fs.existsSync(file)) { console.error('[warn] PMD 报告缺失: ' + file); return }
  const s = fs.readFileSync(file, 'utf8')
  // 文件名在 <file name="..."> 上，violation 内不含路径
  for (const fm of s.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g)) {
    const fpath = fm[1]
    for (const m of fm[2].matchAll(/<violation([^>]*)>([\s\S]*?)<\/violation>/g)) {
      const at = m[1]
      const g = (k) => (at.match(new RegExp(k + '="([^"]*)"')) || [])[1]
      // PMD 违规说明是 <violation> 的直接文本内容
      const msg = (m[2].replace(/^\s+/, '').split(String.fromCharCode(10))[0] || '').trim()
      add('pmd', g('rule'), 'medium', fpath, +g('beginline') || 0, msg.trim(),
        { package: g('package'), method: g('method'), class: g('class'), file: fpath })
    }
  }
}

function parseCheckstyle(file) {
  if (!fs.existsSync(file)) { console.error('[warn] Checkstyle 报告缺失: ' + file); return }
  const s = fs.readFileSync(file, 'utf8')
  let cur = ''
  for (const m of s.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g)) {
    cur = m[1]
    for (const e of m[2].matchAll(/<error line="(\d+)"[^>]*message="([^"]*)"[^>]*source="([^"]*)"/g)) {
      add('checkstyle', (e[3].split('.').pop() || ''), 'low', cur, +e[1], e[2], { file: cur })
    }
  }
}

// ---------- 2) SpotBugs（字节码）----------
const classDirs = new Set(detect.classDirs)
for (const p of poms) {
  const c = path.join(path.dirname(p), 'target', 'classes')
  if (fs.existsSync(c)) classDirs.add(c)
}
// SpotBugs 会连带分析依赖 jar 里的类（如达梦驱动 dm/jdbc，一次能刷出上千条第三方问题）。
// 建本仓 .java 相对路径索引，只保留能对上本仓源码的条目。
const ownJavaIndex = (() => {
  const idx = new Set()
  for (const root of javaRoots) {
    const stack = [root]
    while (stack.length) {
      const d = stack.pop()
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (!e.name.endsWith('.java')) continue
        // 以源码根为基准的相对路径，如 com/jfcloud/common/aspect/TokenUser.java
        idx.add(path.relative(root, p).split(path.sep).join('/'))
      }
    }
  }
  return idx
})()

// 增量模式下判断某相对路径是否属于本次改动范围。
// changedSet 存的是相对仓根的完整路径（如 wpcms_.../src/main/java/com/emvc/Foo.java），
// 工具给的往往是短路径（com/emvc/Foo.java），所以做后缀匹配。
function inChangedScope(relPath) {
  if (!changedSet) return true
  const norm = (relPath || '').split('\\').join('/').replace(/^\.?\//, '')
  if (!norm) return false
  if (changedSet.has(norm)) return true
  for (const c of changedSet) {
    if (c === norm || c.endsWith('/' + norm)) return true
  }
  return false
}

function isOwnSource(srcPath, className) {
  if (!ownJavaIndex.size) return true
  const norm = (srcPath || '').split('\\').join('/')
  if (norm) {
    if (ownJavaIndex.has(norm)) return true
    // SpotBugs 可能只给类路径（com/x/Y.java）或带包前缀，做后缀匹配
    for (const own of ownJavaIndex) {
      if (norm.endsWith('/' + own) || own.endsWith('/' + norm) || norm === own) return true
    }
  }
  // 第三方/混淆类通常没有 sourcepath（如 asposewobfuscated.zz0），只能靠包名反推
  if (className) {
    const asPath = className.split('.').join('/') + '.java'
    // 内部类 Y$Inner -> Y.java
    const outer = asPath.replace(/\$[^/]*\.java$/, '.java')
    return ownJavaIndex.has(asPath) || ownJavaIndex.has(outer)
  }
  return false
}

if (classDirs.size) {
  const sbHome = path.join(TOOLS, 'sb', 'spotbugs-4.8.3')
  const sbJar = path.join(sbHome, 'lib', 'spotbugs.jar')
  if (fs.existsSync(sbJar)) {
    const xml = path.join(outDir, 'spotbugs-report.xml')
    run('java', ['-jar', sbJar, '-textui', '-effort:max', '-low', '-xml:withMessages',
      '-output', xml, ...[...classDirs]], { cwd: sbHome })
    parseSpotbugs(xml)
  }
}

function parseSpotbugs(file) {
  if (!fs.existsSync(file)) { console.error('[warn] SpotBugs 报告缺失: ' + file); return }
  const s = fs.readFileSync(file, 'utf8')
  let dropped = 0
  for (const m of s.matchAll(/<BugInstance([^>]*)>([\s\S]*?)<\/BugInstance>/g)) {
    const at = m[1]
    const g = (k) => (at.match(new RegExp(k + '="([^"]*)"')) || [])[1]
    const body = m[2]
    const srcPath = (body.match(/<SourceLine[^>]*sourcepath="([^"]*)"/) || [])[1] || ''
    const clsName = (body.match(/<Class[^>]*classname="([^"]*)"/) || [])[1] || ''
    if (!isOwnSource(srcPath, clsName)) { dropped++; continue }
    // 增量模式：只保留改动文件里的问题
    const relForScope = srcPath || (clsName ? clsName.split('.').join('/') + '.java' : '')
    if (!inChangedScope(relForScope)) { dropped++; continue }
    const sline = (body.match(/<SourceLine[^>]*start="(\d+)"/) || [])[1] || '0'
    const msg = (body.match(/<ShortMessage>([^<]*)</) || [])[1] || ''
    // 没 sourcepath 时用类名反推一个可读路径
    const fileForReport = srcPath || (clsName ? clsName.split('.').join('/') + '.java' : '')
    add('spotbugs', g('type'), 'high', fileForReport, +sline, msg, { category: g('category'), className: clsName })
  }
  if (dropped) console.error(`[info] SpotBugs 丢弃第三方依赖类问题 ${dropped} 条（非本仓源码）`)
}

// ---------- 3) jscpd（复制族，跨语言）----------
{
  const jscpdHome = path.join(TOOLS, 'jscpd')
  const out = path.join(outDir, 'jscpd')
  fs.mkdirSync(out, { recursive: true })
  // 排除规则用三层合并结果（通用 + 项目级 + 仓级）
  run('npx', ['--registry=https://registry.npmmirror.com', '--package', 'jscpd@5.4.2', 'jscpd',
    '--min-lines', '30', '--min-tokens', '50', '--reporters', 'json',
    '--ignore', ALL_IGNORE.join(','),
    '--output', out, repoPath], { cwd: repoPath, tolerateFailure: true })
  const rep = path.join(out, 'jscpd-report.json')
  if (fs.existsSync(rep)) {
    const d = JSON.parse(fs.readFileSync(rep, 'utf8'))
    let skipped = 0
    for (const dup of d.duplicates || []) {
      const a = dup.firstFile, b = dup.secondFile
      const aRel = path.relative(repoPath, a.name).split(path.sep).join('/')
      const bRel = path.relative(repoPath, b.name).split(path.sep).join('/')
      // 增量模式：克隆的两端都不在改动范围就跳过（改动的代码复制了老代码也算，故任一端命中即保留）
      if (changedSet && !inChangedScope(aRel) && !inChangedScope(bRel)) { skipped++; continue }
      add('jscpd', 'duplicate-clone', 'high',
        a.name.replace(/\\/g, '/'), a.start,
        `与 ${b.name.replace(/\\/g, '/')}:${b.start} 重复 ${dup.lines} 行 / ${dup.tokens} token`,
        { lines: dup.lines, tokens: dup.tokens, cloneOf: b.name.replace(/\\/g, '/'), cloneStart: b.start })
    }
  }
}

// ---------- 4) ruff + radon（Python）----------
if (pyprojects.length) {
  const ruff = path.join(TOOLS, 'ruffbin', 'ruff-0.9.9.data', 'scripts', 'ruff.exe')
  const pytools = path.join(TOOLS, 'pytools')
  if (fs.existsSync(ruff)) {
    const out = path.join(outDir, 'ruff-report.json')
    run(ruff, ['check', repoPath, '--output-format', 'json', '--output-file', out,
      '--select', 'C901,PLR0911,PLR0912,PLR0913,PLR0915,PLR2004,ARG,ERA,TRY,EM,BLE,DTZ,PLW,SLF'],
      { tolerateFailure: true })
    if (fs.existsSync(out)) {
      for (const it of JSON.parse(fs.readFileSync(out, 'utf8'))) {
        add('ruff', it.code, 'medium', it.filename.replace(/\\/g, '/'),
          (it.location && it.location.row) || 0, it.message)
      }
    }
  }
  const radonPy = path.join(pytools, 'radon')
  if (fs.existsSync(path.join(radonPy, 'cli'))) {
    const outTxt = path.join(outDir, 'radon-cc.txt')
    const o = run('python', ['-c',
      `import sys; sys.path.insert(0, r'${pytools}');` +
      `from radon import main; sys.argv=['radon','cc',r'${repoPath}','-s','-n','C','-a']; main()`,
    ], { cwd: repoPath })
    fs.writeFileSync(outTxt, o, 'utf8')
    if (process.env.LEGACY_AUDIT_DEBUG) console.error('[radon-raw] ' + o.slice(0, 400))
    let curFile = ''
    for (const line of o.split('\n')) {
      if (line && !line.startsWith(' ') && line.includes(' - ')) curFile = line.split(' - ')[0]
      const m = line.match(/^\s+([FMPC])\s+\d+:\d+\s+(\S+)\s+-\s+([A-F])\s+\((\d+)\)/)
      if (m) add('radon', 'complexity-' + m[3], 'medium', curFile, 0,
        `${m[2]} 复杂度 ${m[3]}(${m[4]})`, { grade: m[3], score: +m[4] })
    }
  }
}

// ---------- 5) ESLint（TS/JS/Vue）----------
if (pkgs.length) {
  const out = path.join(outDir, 'eslint-report.json')
  // 用 skill 自带的独立 ESLint（tools/eslint-tool）：业务仓可能装 ESLint 9 或 flat config，
  // 走 npx 会优先命中本地版本导致参数不兼容（--no-eslintrc 在 9.x 被移除）；
  // 规则文件必须放在 eslint-tool 目录内，parser 才能解析到 node_modules
  const eslintHome = path.join(TOOLS, 'eslint-tool')
  const eslintCfg = path.join(eslintHome, 'eslint-legacy.json')
  const eslintBin = path.join(eslintHome, 'node_modules', '.bin',
    process.platform === 'win32' ? 'eslint.cmd' : 'eslint')
  // 排除规则用三层合并结果（通用 + 项目级 + 仓级）
  const ignoreArgs = ALL_IGNORE.flatMap(p => ['--ignore-pattern', p])
  if (!fs.existsSync(eslintBin) || !fs.existsSync(eslintCfg)) {
    console.error('[warn] 独立 ESLint 未安装，跳过前端扫描：在 tools/eslint-tool 跑 npm install')
  } else {
    // 增量模式：只传改动过的前端文件（必须落在某个 package.json 目录下）
    const FRONT_EXT = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs']
    let eslintTargets = pkgs.map(p => path.dirname(p))
    if (changedSet) {
      const pkgDirs = pkgs.map(p => path.dirname(p).split(path.sep).join('/'))
      eslintTargets = [...changedSet]
        .filter(rel => FRONT_EXT.includes(path.extname(rel).toLowerCase()))
        .filter(rel => pkgDirs.some(d => {
          const abs = path.join(repoPath, rel.split('/').join(path.sep)).split(path.sep).join('/')
          return abs.startsWith(d + '/')
        }))
        .map(rel => path.join(repoPath, rel.split('/').join(path.sep)))
        // git log 会列出已删除的文件，ESLint 遇到不存在的路径整体失败，先过滤
        .filter(p => fs.existsSync(p))
      if (!eslintTargets.length) {
        console.error('[info] 增量范围内没有前端改动文件，跳过 ESLint')
      } else {
        console.error(`[info] 前端增量文件 ${eslintTargets.length} 个，ESLint 只扫这些`)
      }
    }
    if (process.env.LEGACY_AUDIT_DEBUG && eslintTargets.length) {
      const probe = [eslintBin, '--no-eslintrc', '-c', eslintCfg, '--ext', '.ts,.tsx,.js,.jsx,.vue,.mjs',
        '--resolve-plugins-relative-to', eslintHome, ...ignoreArgs, '--format', 'json',
        '--output-file', out, ...eslintTargets].join(' ')
      console.error('[eslint-cmd-len] ' + probe.length + ' 参数数=' + (13 + ignoreArgs.length + eslintTargets.length))
      console.error('[eslint-targets-sample] ' + eslintTargets.slice(0, 2).join(' | '))
    }
    if (eslintTargets.length) run(eslintBin, ['--no-eslintrc',
      '-c', eslintCfg, '--ext', '.ts,.tsx,.js,.jsx,.vue,.mjs',
      '--resolve-plugins-relative-to', eslintHome,
      ...ignoreArgs,
      '--format', 'json', '--output-file', out, ...eslintTargets],
      // 业务仓若有 eslint.config.js，ESLint 8.57 会切 flat config 模式使 --no-eslintrc 失效，
      // 用环境变量强制走 legacy 模式
      { cwd: repoPath, tolerateFailure: true, env: { ESLINT_USE_FLAT_CONFIG: 'false' } })
  }
  if (fs.existsSync(out)) {
    for (const f of JSON.parse(fs.readFileSync(out, 'utf8'))) {
      for (const msg of f.messages) {
        add('eslint', msg.ruleId || 'parse-error', msg.severity === 2 ? 'high' : 'low',
          f.filePath.replace(/\\/g, '/'), msg.line || 0, msg.message)
      }
    }
  }
}

// ---------- 6) cargo clippy（Rust）----------
if (cargos.length) {
  const out = path.join(outDir, 'clippy-report.txt')
  const o = run('cargo', ['clippy', '--message-format', 'short', '--all-targets'],
    { cwd: path.dirname(cargos[0]), timeout: 600000 })
  if (process.env.LEGACY_AUDIT_DEBUG) console.error('[clippy-raw] ' + o.slice(0, 300))
  fs.writeFileSync(out, o, 'utf8')
  for (const line of o.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(\d+):\s+(warning|error):\s+(.+)$/)
    if (m) add('clippy', m[6] || 'clippy', m[4] === 'error' ? 'high' : 'low', m[1], +m[2], m[5])
  }
}

// ---------- 输出 ----------
const result = {
  repo: repoName, repoPath, scannedAt: new Date().toISOString(),
  incremental: incRef || null,
  profile: {
    javaRoots: [...javaRoots], classDirs: [...classDirs],
    pyRoots: pyprojects, webRoots: pkgs.map(p => path.dirname(p)), rustRoots: cargos,
  },
  counts: {},
  findings,
}
for (const f of findings) result.counts[f.tool] = (result.counts[f.tool] || 0) + 1
fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify(result, null, 1), 'utf8')
console.log(JSON.stringify({ repo: repoName, total: findings.length, counts: result.counts }, null, 1))
