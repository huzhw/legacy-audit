// legacy-audit · 仓库画像探测（供配置校对用）
// 用法：node detect.mjs <repoPath>
import fs from 'node:fs'
import path from 'node:path'

const repoPath = process.argv[2]
const SKIP = ['node_modules', 'target', 'dist', 'build', '.git', '.venv', 'venv', '__pycache__', '.idea', 'out', 'bin', 'obj']
const isSkipped = (n) => SKIP.includes(n) || /^node_modules\d*\w*$/.test(n)

function walk(dir, depth, acc, maxDepth = 5) {
  if (depth > maxDepth) return
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    if (isSkipped(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.name === 'java' && dir.endsWith('src' + path.sep + 'main')) { acc.javaRoots.push(p); continue }
    if (e.name === 'classes' && dir.endsWith('target')) { acc.classDirs.push(p); continue }
    if (e.name === 'src' && depth <= 3) { walk(p, depth + 1, acc, maxDepth); continue }
    walk(p, depth + 1, acc, maxDepth)
  }
}
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
      } else if (names.includes(e.name)) res.push(path.join(d, e.name))
    }
  }
  rec(root, 0)
  return res
}

const acc = { javaRoots: [], classDirs: [] }
walk(repoPath, 0, acc)

const poms = findFiles(repoPath, ['pom.xml'])
const pkgs = findFiles(repoPath, ['package.json'])
const pys = findFiles(repoPath, ['pyproject.toml', 'setup.py', 'requirements.txt'])
const cargos = findFiles(repoPath, ['Cargo.toml'])
const csprojs = findFiles(repoPath, ['*.csproj'])

function countFiles(dir, exts) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.isDirectory()) { if (!isSkipped(e.name)) stack.push(path.join(d, e.name)); continue }
      if (exts.some(x => e.name.endsWith(x))) n++
    }
  }
  return n
}

const out = {
  repo: path.basename(repoPath),
  path: repoPath,
  javaRoots: acc.javaRoots.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  classDirs: acc.classDirs.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  poms: poms.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  pkgs: pkgs.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  python: pys.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  rust: cargos.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  dotnet: csprojs.map(p => path.relative(repoPath, p).replace(/\\/g, '/')),
  fileCounts: {
    java: countFiles(repoPath, ['.java']),
    ts: countFiles(repoPath, ['.ts', '.tsx']),
    vue: countFiles(repoPath, ['.vue']),
    js: countFiles(repoPath, ['.js', '.jsx', '.mjs']),
    py: countFiles(repoPath, ['.py']),
    rs: countFiles(repoPath, ['.rs']),
    cs: countFiles(repoPath, ['.cs']),
    sql: countFiles(repoPath, ['.sql']),
    jsp: countFiles(repoPath, ['.jsp']),
  },
}
console.log(JSON.stringify(out, null, 1))
