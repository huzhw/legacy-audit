# legacy-audit — 屎山体检

对多仓项目做级联静态扫描，用 PMD / Checkstyle / SpotBugs / ESLint / ruff / radon / clippy / jscpd 八套工具摸清技术债存量，**只报相对基线新增的问题**，产出分级清单。

## 相关技能
- [agent-config-sync-check](https://github.com/huzhw/agent-config-sync-check)：八端同步守卫：链接/硬链接/README 同步检查与修复
- [code-check](https://github.com/huzhw/code-check-skill)：增量代码隐患检查
- [coding-rules](https://github.com/huzhw/coding-rules)：编码规则库（独立仓库，非 skill）
- [daily-merge-gitlab-excel](https://github.com/huzhw/daily-merge-gitlab-excel-skill)：日报合并（手动兜底，已由日报管家接管，不推荐）
- [daily-record-gitlab-md](https://github.com/huzhw/daily-record-gitlab-md-skill)：日报记录（第一步）
- [daily-report-panel](https://github.com/huzhw/daily-report-panel)：日报管家（关联仓库，非 skill，自动合并/导出/发件）
- [deepseek-harness-plugin-doctor](https://github.com/huzhw/deepseek-harness-plugin-doctor)：DeepSeek Harness 插件与升级体检医生
- [deepseek-harness-settings-curator](https://github.com/huzhw/deepseek-harness-settings-curator)：DeepSeek Harness 模型配置梳理
- [dev-env-upgrade](https://github.com/huzhw/dev-env-upgrade)：开发环境升级医生：版本体检/最新版查询/安全升级
- [git-commit](https://github.com/huzhw/git-commit-skill)：Git 提交规范
- [memory-ai-cleanup](https://github.com/huzhw/memory-ai-cleanup)：memory-ai 记录定期清理：删过期流水、摘索引死链、清 tmp 残留
- [prd](https://github.com/huzhw/prd-skill)：PRD 生成器（一句话需求→结构化需求文档）
- [ralph](https://github.com/huzhw/ralph-skill)：PRD 转 prd.json（Ralph 自主执行格式）
- [reread-rules](https://github.com/huzhw/reread-rules-skill)：重载 CLAUDE.md / AGENTS.md 规则
- [ssh-transfer](https://github.com/huzhw/ssh-transfer)：服务器传文件走命令行（scp/sftp 流式，字节不进模型上下文）

---

## 解决了什么问题

老项目第一次跑静态分析会出几万条历史债，没人看第二次；而真正要紧的是「这次改动新造了什么屎山」。这个技能把**基线棘轮**做进流程：首次扫描全量入库当存量，之后每次只报新增，基线能收能放。

## 核心能力

- **八套工具矩阵** — Java 走 PMD / Checkstyle / SpotBugs，前端走 ESLint，Python 走 ruff / radon，Rust 走 clippy，跨语言复制族走 jscpd（唯一能跨文件、跨仓抓克隆的）
- **基线棘轮** — 指纹 = 工具 + 规则 + 相对路径 + 代码片段哈希，**不含行号**，代码挪行不会误判成「已修复 + 新增」；基线存各仓 `.legacy-audit/baseline.json`，可随仓提交供团队共享
- **老项目不查** — 仓里没基线时首扫自动建档，历史债全算存量、输出「新增 0」；要看全量显式加 `--report-first-run`
- **增量查改动** — `--changed-since <日期> --changed-author <人>` 只扫这段时间本人动过的文件，实测底稿主仓 31030 条噪声压到 3803 条
- **排除三层** — 通用层（`node_modules` 变体、`dist`、`vendor`、`*.md`）写脚本里，项目层写 `projects.json`，仓层写 `<仓>/.legacy-audit/ignore.txt`；三层合并去重后统一喂给 ESLint 与 jscpd
- **四档分级** — P0 结构性（上帝类、超长方法、圈复杂度 >20）/ P1 风险性（死代码、空 catch、SQL 拼接）/ P2 重复 / P3 卫生
- **只报不修** — 产出是清单，不是改造任务；定级与排期由人做

## 配置与目录

```
legacy-audit/
  SKILL.md
  scripts/
    projects.json      级联配置：一份管全部项目（工作区根 / 排除 / 分组 / 仓级中文名）
    detect.mjs         单仓画像
    scan-repo.mjs      单仓扫描 → findings.json
    scan-project.mjs   级联调度 + 基线比对 + 汇总
    baseline.mjs       基线 build / diff / update
    report.mjs         合并去重分级 → Markdown 表
    install-tools.ps1  工具恢复脚本（换机器后跑）
  tools/               二进制与规则集（二进制不进 git，规则集进 git）
  references/grading.md 四档分级口径与已知合理例外
  tmp/report/<项目名>/  扫描产物（不进 git）
```

**业务仓不放配置**：项目清单、规则集、工具二进制全部跟着技能仓走，改一处不用改 N 个仓。

## 安装

```bash
git clone https://github.com/huzhw/legacy-audit.git ~/.claude/skills/legacy-audit
```

换机器后装工具二进制：

```powershell
pwsh -NoProfile -File scripts\install-tools.ps1
```

本机五端（Claude Code / DeepSeek Harness / Codex / ZCode / Qoder CN）以 junction 指向 `F:\idea-workspase-skills\legacy-audit`，详见 `JUNCTION说明.md`。

## 常用命令

```bash
# 全部项目（首扫自动建档，历史债不报）
node scripts/scan-project.mjs

# 只查这周本人的改动
node scripts/scan-project.mjs --project 中信底稿V5 --changed-since 2026-11-02 --changed-author huzhiwei --report-first-run

# 出报告
node scripts/report.mjs tmp/report --all
```

## 许可

MIT

最后修改：2026-11-06
