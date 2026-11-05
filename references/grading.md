# 四档分级口径

> 工具只报**结构事实**，不定业务风险。本文件给「事实 → 档位」的映射规则。
> 定级由人拍板；本文件是默认建议，架构师可覆盖。

## P0 结构性（进 backlog，季度排期重构）

| 工具 | 规则 | 判据 |
|---|---|---|
| pmd | `GodClass` | 类内方法数与字段数双高 |
| pmd | `ExcessiveMethodLength` | 方法 > 100 行 |
| pmd | `ExcessiveClassLength` | 类 > 1000 行 |
| pmd | `CognitiveComplexity` | > 20 |
| pmd | `CyclomaticComplexity` | > 15 |
| checkstyle | `MethodLength` | > 120 行 |
| checkstyle | `FileLength` | > 1500 行 |
| checkstyle | `ClassFanOutComplexity` | > 25 |
| checkstyle | `NestedIfDepth` | > 4 |
| radon | 复杂度评级 | **D / E / F** |
| ruff | `C901` | 复杂结构 |
| ruff | `PLR0912` / `PLR0915` | 分支 > 12 / 语句 > 50 |
| eslint | `complexity` / `max-statements` | > 20 / > 60 |
| jscpd | 复制族 | **≥ 100 行**的克隆（整段复制，改一处漏三处） |
| jscpd | 复制族 | 50~99 行（跨仓克隆尤其可疑） |

## P1 风险性（修代码时顺手清）

| 工具 | 规则 | 为什么重要 |
|---|---|---|
| spotbugs | `UPM_UNCALLED_PRIVATE_METHOD` | 写了没人调 = 死代码 |
| spotbugs | `DLS_DEAD_LOCAL_STORE` | 赋值即被覆盖 = 逻辑 bug 温床 |
| spotbugs | `SQL_PREPARED_STATEMENT_GENERATED_FROM_NONCONSTANT_STRING` | SQL 拼接风险 |
| spotbugs | `DM_DEFAULT_ENCODING` | 编码不确定，中文场景是坑 |
| pmd | `EmptyCatchBlock` | 吞异常，上游分不清「没值」和「出错」 |
| ruff | `BLE001` | 裸 except 吞一切 |
| clippy | `unwrap_used` 类 | 误用直接 panic |
| eslint | `no-empty` | 空分支 |
| checkstyle | `IllegalCatch` / `IllegalThrows` | 捕获/抛出 Exception |

## P2 重复（合并到工具类）

| 工具 | 规则 |
|---|---|
| pmd | `AvoidDuplicateLiterals`（同文件字面量 ≥ 8 次） |
| checkstyle | `MultipleStringLiterals` |
| ruff | `PLR2004`（魔法值比较）——挑业务常量的报，枚举型的忽略 |
| pmd | `DataflowAnomalyAnalysis`（值写了不用） |

## P3 卫生（批量脚本清）

| 工具 | 规则 |
|---|---|
| pmd | `UnusedImports` / `UnusedAssignment` |
| checkstyle | `UnusedImports` / `UnusedLocalVariable` / `RedundantImport` |
| eslint | `no-unused-vars` / `prefer-const` / `no-var` |
| ruff | `ARG001`/`ARG002`（未用参数） |

---

## 已知合理例外（工具会报，但本项目合理）

登记在这里的，报告里标注「合理例外」而不是删条目。

### Java
- **`finally` 里关流的空 catch**：`catch (IOException ignored) { // 资源流关闭异常无影响 }` —— 正确写法，不是缺陷
- **`catch` 里只记日志不重抛**：若该异常属「可降级」场景（如图标缺失、单个提醒发失败），属设计意图；需逐条确认
- **Service 里直接写 SQL 字符串**：仅限**跨 schema 动态拼接表名**（`props.getSchemaBiz() + ".TABLE"`），表名来自配置非用户输入，无注入风险
- **超长方法**：若方法内是**连续的常量/配置声明**或**纯 SQL 映射表**，不算屎山

### 前端
- **`any` 类型**：存量 React 项目常见，只要没流到 `dangerouslySetInnerHTML`
- **组件超长**：若组件本身是「页面级聚合组件」且逻辑线性可读，暂不拆

### Python
- **`BLE001` 裸 except**：若在**最外层入口**做兜底日志，属合理
- **`PLR2004` 魔法值**：HTTP 状态码、时间单位（秒/毫秒）常量，建议提常量但不算缺陷
- **`ARG002` 未用参数**：若参数是**接口签名要求**（框架回调、Django signal），属合理

### Rust
- **`clippy::too_many_arguments`**：若函数是**状态机的一步**（语义内聚），拆分会降低可读性

---

## 阈值调整记录

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-11-05 | 初版 | PMD 精选 10 类规则，Checkstyle 精选 30 项，jscpd ≥30行/≥50token |

> 改阈值走提案制：先看 ≥3 次实证偏差，再改本文件。
