// legacy-audit 屎山体检扫描器
// 职责：按仓库画像调用多语言静态分析工具，输出统一 JSON findings
// 用法：node scan-repo.mjs <repoPath> <repoName> <outDir> [--incremental <gitRef>]
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TOOLS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools')
const SKILL = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

// 跳过目录：兼容 node_modules0606 / node_modules_backup 等变体
const SKIP_DIRS = ['node_modules', 'target', 'dist', 'build', '.git', '.venv', 'venv', '__pycache__', '.idea', 'out', 'bin', 'obj']
const isSkipped = (n) => SKIP_DIRS.includes(n) || /^node_modules\d*\w*$/.test(n)

const argv = process.argv.slice(2)
const repoPath = argv[0]
const repoName = argv[1] || path.basename(repoPath)
const outDir = argv[2] || path.join(repoPath, '.legacy-audit', 'out')
const incIdx = argv.indexOf('--incremental')
const incRef = incIdx > 0 ? argv[incIdx + 1] : null

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
    const msg = '[run-fail] ' + cmd + ' :: ' + String(e.message || e).slice(0, 300)
    console.error(msg)
    if (process.env.LEGACY_AUDIT_DEBUG) {
      console.error((e.stdout || '') + (e.stderr || ''))
    }
    return (e.stdout || '') + (e.stderr || '')
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
if (javaRoots.size) {
  const work = path.join(outDir, '_mvn')
  fs.mkdirSync(work, { recursive: true })
  const srcList = [...javaRoots].join('\n            ')
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

function isOwnSource(srcPath) {
  if (!srcPath) return true          // 没路径信息的保守保留
  if (!ownJavaIndex.size) return true
  const norm = srcPath.split('\\').join('/')
  if (ownJavaIndex.has(norm)) return true
  // SpotBugs 可能只给类路径（com/x/Y.java）或带包前缀，做后缀匹配
  for (const own of ownJavaIndex) {
    if (norm.endsWith('/' + own) || own.endsWith('/' + norm) || norm === own) return true
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
    if (!isOwnSource(srcPath)) { dropped++; continue }
    const sline = (body.match(/<SourceLine[^>]*start="(\d+)"/) || [])[1] || '0'
    const msg = (body.match(/<ShortMessage>([^<]*)</) || [])[1] || ''
    add('spotbugs', g('type'), 'high', srcPath, +sline, msg, { category: g('category') })
  }
  if (dropped) console.error(`[info] SpotBugs 丢弃第三方依赖类问题 ${dropped} 条（非本仓源码）`)
}

// ---------- 3) jscpd（复制族，跨语言）----------
{
  const jscpdHome = path.join(TOOLS, 'jscpd')
  const out = path.join(outDir, 'jscpd')
  fs.mkdirSync(out, { recursive: true })
  // 必须排除构建产物与第三方 vendored 代码，否则 node_modules 里的库会刷出上千条"克隆"
  const jscpdIgnore = [
    '**/node_modules/**', '**/node_modules*/**',
    '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/.next/**',
    '**/*.min.js', '**/public/pdf/**', '**/static/js/lib/**',
    '**/vendor/**', '**/vendors/**',
  ]
  const repoIgnoreJ = path.join(repoPath, '.legacy-audit', 'ignore.txt')
  if (fs.existsSync(repoIgnoreJ)) {
    for (const line of fs.readFileSync(repoIgnoreJ, 'utf8').split('\n')) {
      const t = line.trim()
      if (t && !t.startsWith('#')) jscpdIgnore.push(t)
    }
  }
  run('npx', ['--registry=https://registry.npmmirror.com', '--package', 'jscpd@5.4.2', 'jscpd',
    '--min-lines', '30', '--min-tokens', '50', '--reporters', 'json',
    '--ignore', jscpdIgnore.join(','),
    '--output', out, repoPath], { cwd: repoPath })
  const rep = path.join(out, 'jscpd-report.json')
  if (fs.existsSync(rep)) {
    const d = JSON.parse(fs.readFileSync(rep, 'utf8'))
    for (const dup of d.duplicates || []) {
      const a = dup.firstFile, b = dup.secondFile
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
      '--select', 'C901,PLR0911,PLR0912,PLR0913,PLR0915,PLR2004,ARG,ERA,TRY,EM,BLE,DTZ,PLW,SLF'])
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
  const eslintCfg = path.join(TOOLS, 'eslint-legacy.json')
  // 必须排除构建产物与第三方 vendored 代码，否则 dist/node_modules 会把结果撑到几十万条
  const ignorePatterns = [
    '**/node_modules/**', '**/node_modules*/**',
    '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/coverage/**',
    '**/*.min.js', '**/public/pdf/**', '**/static/js/lib/**',
  ]
  // 仓级自定义忽略：<repo>/.legacy-audit/ignore.txt，每行一个 glob，以 # 开头为注释
  const repoIgnore = path.join(repoPath, '.legacy-audit', 'ignore.txt')
  if (fs.existsSync(repoIgnore)) {
    for (const line of fs.readFileSync(repoIgnore, 'utf8').split('\n')) {
      const t = line.trim()
      if (t && !t.startsWith('#')) ignorePatterns.push(t)
    }
  }
  const ignoreArgs = ignorePatterns.flatMap(p => ['--ignore-pattern', p])
  // ESLint 8.x：--no-eslintrc 才是不读工程内配置；9.x 移除了该参数
  run('npx', ['--registry=https://registry.npmmirror.com', '--package', 'eslint@8.57.1', 'eslint', '--no-eslintrc',
    '-c', eslintCfg, '--ext', '.ts,.tsx,.js,.jsx,.vue,.mjs',
    ...ignoreArgs,
    '--format', 'json', '--output-file', out, ...pkgs.map(p => path.dirname(p))],
    { cwd: repoPath })
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
