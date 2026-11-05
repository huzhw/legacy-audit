---
name: legacy-audit
description: 屎山体检（legacy code audit）。用 PMD / Checkstyle / SpotBugs / ESLint / ruff / radon / clippy / jscpd 八套开源静态分析工具，对多仓项目做级联扫描，产出「新增技术债」清单与分级报告。触发词：屎山体检、屎山扫描、遗留代码梳理、代码体检、legacy audit、技术债扫描、代码质量基线、复制族检测、跨仓克隆、代码复杂度扫描。
---

# 屎山体检（legacy audit）

> 本 skill 是**全局技能**（`F:\idea-workspase-skills\legacy-audit\`），跨项目复用。
> 每个项目根放一份 `legacy-audit.projects.json` 声明「本项目有哪些仓、怎么分组」，skill 读它做级联。
> 规则集、脚本、工具二进制全部与项目无关，不进业务仓。

## 0. 何时用 / 不用

**用**：
- 定期（建议每月一次）全量体检，摸清各仓技术债存量并排期
- 提交前自检：确认这次改动没新造屎山（增量模式，秒级）
- 重构前摸底：想知道哪个文件是真正的瓶颈、哪几处是复制族
- 跨仓查同构：两个项目是否实现了同一套东西

**不用**：
- 想「修」代码——本 skill **只报不修**，修复是另一件事（走 normal 开发流程）
- 存量线上代码的「顺手优化」——本 skill 的产出是**清单**，不是改造任务
- 替代单元测试与集成测试——静态分析只能看结构，看不到业务正确性

## 1. 工具矩阵（八套，全部本地 CLI、零服务依赖）

| 工具 | 覆盖 | 看什么 | 独有价值 |
|---|---|---|---|
| **PMD 6.55** | Java | 上帝类、超长方法、圈/认知复杂度、空 catch、重复字面量 | 结构体量的主力 |
| **Checkstyle 10.12** | Java | 方法/文件长度、嵌套深度、耦合度 | 补 PMD 的量化维度 |
| **SpotBugs 4.8.3** | Java 字节码 | 死代码（未调私有方法/死赋值）、SQL 注入、编码不确定 | **只有它能查字节码级死代码** |
| **ESLint 8.57** | TS/TSX/Vue/JS | 复杂度、超长文件、悬空 promise、空分支 | 前端唯一选项 |
| **ruff 0.9.9** | Python | 复杂结构、分支/语句/参数过多、裸 except | 极快（秒级） |
| **radon 6.0.1** | Python | 圈复杂度评级（A~F） | 复杂度**分档**，可定阈值 |
| **cargo clippy** | Rust | 参数过多、impl 可派生、unwrap 误用 | Rust 官方 |
| **jscpd 5.4.2** | **全部语言 + 跨仓** | 复制粘贴族 | **唯一能跨文件、跨仓、跨语言抓克隆** |

**工具装在** `F:\idea-workspase-skills\legacy-audit\tools\`（git 排除）。Maven 走阿里云镜像，npm 走 npmmirror，PyPI 走阿里云——**内网可用**。

## 2. 三层目录结构

```
legacy-audit/                    ← 全局仓（本 skill）
  SKILL.md
  scripts/
    detect.mjs        探测单仓画像（Java 根、class 目录、py/pom/pkg/cargo 位置）
    scan-repo.mjs     扫单仓：按画像调用对应工具 → findings.json
    scan-project.mjs  级联调度：项目 → 组 → 仓 → 基线比对 → 汇总
    baseline.mjs      基线棘轮：build / diff / update
    report.mjs        合并去重分级 → 出表（Markdown）
  tools/                        ← 二进制与规则集（git 排除）
    legacy-audit.xml            PMD 精选规则集
    checkstyle-legacy.xml       Checkstyle 精选规则集
    eslint-legacy.json          ESLint 规则
    sb/ spotbugs-4.8.3/         SpotBugs 发行版
    ruffbin/ ruff-0.9.9.../     ruff 可执行
    pytools/                    radon + 依赖
  references/
    grading.md                  四档分级口径 + 已知合理例外

<项目根>/legacy-audit.projects.json   ← 项目级配置（分组 / 排除）
<子仓>/.legacy-audit/baseline.json    ← 该仓基线（建议提交 git，团队共享）
```

## 3. 用法

### 3.1 全量体检（首次 / 定期）

```bash
# 中信底稿V5
node F:/idea-workspase-skills/legacy-audit/scripts/scan-project.mjs \
  F:/idea-workspase-zhongXin-diGaoV5/standard_thdg_zxdm/legacy-audit.projects.json \
  --out F:/idea-workspase-zhongXin-diGaoV5/standard_thdg_zxdm/.legacy-audit/report \
  --update-baseline
```

`--update-baseline` = 把当前全部问题记为基线（**历史债不计入新增账**）。首次必须带这个参数。

### 3.2 日常增量（提交前自检）

```bash
node .../scan-project.mjs <项目配置> --out <报告目录>
```

不带 `--update-baseline` → 只报**相对基线新增**的问题。基线里的历史债不再重复刷屏。

### 3.3 只扫某几个仓

```bash
node .../scan-project.mjs <项目配置> --only workingpaper-flow,standard_thdg_zxdm
```

### 3.4 单仓画像

```bash
node .../detect.mjs <仓路径>
```

## 4. 基线棘轮（核心机制）

**问题**：首次扫描会出几万条噪声（历史债），没人看第二次。

**做法**：
1. **首次**：全量扫，每条问题算一个**指纹** → 存 `.legacy-audit/baseline.json`
   - 指纹 = `tool + 规则 + 相对文件路径 + 问题代码片段哈希`
   - **不用行号**——代码行挪动不会误判为「已修复 + 新增」
2. **日常**：扫完和基线算差集，**只报新增**
3. **收紧**：修掉一批后重跑 `--update-baseline`，基线缩小

**基线提交进 git**：团队共享，否则每人一份基线，别人新写的问题你看不到。

**例外白名单**：`references/grading.md` 里登记「本仓合理但工具会报的」模式，报告里标注而不是删。

## 5. 四档分级

| 档 | 判据 | 处置 |
|---|---|---|
| **P0 结构性** | 上帝类、超长方法(>120行)、圈复杂度>20、跨文件复制族 | 进 backlog，按季度排期重构 |
| **P1 风险性** | 死代码、空 catch、SQL 拼接、裸 except、误用 unwrap | 修代码时顺手清 |
| **P2 重复** | 重复字面量、重复 import、多处字符串拼接 | 合并到工具类 |
| **P3 卫生** | 未用变量、未用 import、命名 | 可批量脚本清 |

分级细则与阈值见 `references/grading.md`。

## 6. 输出物

1. `summary.json` —— 项目级汇总（按仓、按组、按工具）
2. `<仓>/findings.json` —— 该仓全部发现（含原始工具报告 xml/json）
3. `report.md` —— **给人看的表**，可直接粘进项目债务清单：

```markdown
| 序号 | 仓库 | 主题 | 风险 | 证据锚点 | 工具 |
|---|---|---|---|---|---|
| 1 | standard_thdg_zxdm | 三处复制族：MailNotifier/CatalogEngine/FileEngine 各两套 | 中 | service/file/CopyPasteTaskMailNotifier.java:229 ⇄ CopyTaskMailNotifier.java:227 | jscpd |
```

## 7. 已知坑（踩过的，别再踩）

| 坑 | 现象 | 解法 |
|---|---|---|
| **Maven 属性不生效** | `-Dxxx` 传给插件配置里的 `${xxx}` 读不到 | 扫描时**生成临时 pom**（脚本已做），别硬传属性 |
| **PMD 报告路径** | 在 `target/pmd.xml`，**不是** `target/pmd/pmd.xml` | 脚本已按正确路径读 |
| **PMD 分析缓存** | 二次跑被跳过，输出为空 | 每次跑前清 `target` + `-Dpmd.analysisCache=false` |
| **Checkstyle 层级** | 文件级检查必须在 `Checker` 层，源码级在 `TreeWalker` 层 | 规则集已分层，改动时勿混 |
| **Checkstyle 规则名** | `GodClass` 在 10.x 已移除；`ArrayTypeStyle`/`DuplicateStringLiteral` 不存在 | 用 `ClassFanOutComplexity` 近似上帝类；改名 `MultipleStringLiterals` |
| **Guava 冲突** | checkstyle-plugin 3.3.1 与 Checkstyle 10.x 不兼容 | 插件用 **3.6.0** |
| **Windows .cmd** | `execFileSync('mvn')` 报 ENOENT | 必须 `cmd /c`，且加 `2>&1` 合并 stderr（cargo/clippy 输出在 stderr） |
| **npx 拉最新版** | ESLint 9 移除了 `--no-eslintrc` | 锁 `eslint@8.57.1`；jscpd 锁 `5.4.2` |
| **node_modules 变体** | `node_modules0606` 被当源码扫（3577 个假 ts 文件） | 跳过正则 `/^node_modules\d*\w*$/` |
| **构建文件不在仓根** | zxdm / fileCluster / audit-log-system / MOBILE_DG_V1 的 pom 都在子目录 | 探测下钻 4 层 |
| **多模块仓** | MOBILE_DG_V1 有 4 个 Maven 模块，各有 target/classes | SpotBugs 逐个 class 目录扫 |
| **radon 6.x 入口** | `radon.cli.main` 不存在 | 入口是 `radon:main` |
| **无编译产物** | SpotBugs 需 `.class`；没有就**跳过并标注未验证** | 不许假装跑过 |

## 8. 与既有体系的衔接

- **底稿主仓**已有 `docs/dev-spec/15-存量债务清单.md`（44 条手工登记的存量债）。本 skill 的产出应**并入该清单**，不是另起一套——避免两份清单打架。
- 该清单条目**已在册的**，报告里标「已登记」，不重复计新增。
- 工具**不判断业务风险**，只报结构事实。定级与排期由人做。
