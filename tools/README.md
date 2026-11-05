# tools 目录说明与恢复

> 本目录的**二进制**不进 git（约 80MB），只提交**规则集**与 **Maven 跑腿工程**。
> 换机器 / 他人 clone 后，跑一次 `scripts/install-tools.ps1` 即可恢复。

## 进 git 的文件

| 文件 | 用途 |
|---|---|
| `legacy-audit.xml` | PMD 6.55 精选规则集（10 类结构性规则） |
| `checkstyle-legacy.xml` | Checkstyle 10.12 精选规则集（Checker 层 + TreeWalker 层） |
| `eslint-legacy.json` | ESLint 8.57 规则（前端） |
| `mvn-runner/pom.xml` | Maven 跑腿工程模板（PMD + Checkstyle 插件声明） |

## 不进 git 的二进制

| 目录 | 内容 | 来源 |
|---|---|---|
| `sb/` | SpotBugs 4.8.3 发行版（46MB） | 阿里云 Maven `com/github/spotbugs/spotbugs/4.8.3/spotbugs-4.8.3.tgz` |
| `ruffbin/` | ruff 0.9.9 Windows 可执行（33MB） | 阿里云 PyPI `ruff-0.9.9-py3-none-win_amd64.whl` |
| `pytools/` | radon 6.0.1 + 依赖（1.3MB） | 阿里云 PyPI `radon==6.0.1` |
| `jscpd/` | jscpd 工作目录（1.2MB） | npmmirror |
| `eslint-tool/node_modules/` | 独立 ESLint 8.57.1 + TS/Vue parser + typescript（约 60MB） | `npm install`（npmmirror） |
| `checkstyle.jar` | Checkstyle 独立 jar（2.1MB，备用） | 阿里云 Maven |

## 恢复方式

```powershell
pwsh -NoProfile -File scripts\install-tools.ps1
```

脚本做的事：
1. 建目录
2. 从阿里云 Maven 拉 SpotBugs tgz 并解压
3. 从阿里云 PyPI 拉 ruff wheel 并解包可执行
4. `pip install --target pytools radon==6.0.1`
5. 校验各工具 `--version` 可执行

**ESLint 为什么单独装一份**：业务仓可能装 ESLint 9 或有 `eslint.config.js`，
走 npx 会优先命中本地版本导致 `--no-eslintrc` 非法、整个仓静默 0 条。独立实例
用绝对路径调用，规则文件必须与 `node_modules` 同目录（parser 才能解析）。
playwright 同理不再依赖业务仓。

**PMD / Checkstyle 不需要单独装** —— 由 Maven 在扫描时自动下载（走 `~/.m2/settings.xml` 里配的阿里云镜像）。
**jscpd / ESLint** 由 `npx --registry=https://registry.npmmirror.com` 即时拉取，版本已在 `scan-repo.mjs` 里锁定（jscpd@5.4.2、eslint@8.57.1）。
**cargo clippy** 要求本机已装 Rust（`rustup` 管理）。
