# Nginx 接口性能分析

使用 Node.js 将 nginx的日志 access log 转为美化的、可搜索排序的离线 HTML 报告，辅助定位上游连接、首包等待和响应传输瓶颈。无需安装依赖，不上传日志，不加载 CDN。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
# 分析一个文件
node analyze.mjs /var/log/nginx/access.log -o report.html

# 生成当前示例的报告
npm run demo

# 合并轮转文件，设置 500 ms 慢请求阈值，同时导出 JSON
node analyze.mjs access.log.2.gz access.log.1 access.log \
  --slow-ms 500 --top 30 -o reports/nginx.html --json reports/stats.json

# 从标准输入读取；与文件输入一样，报告仍输出到指定文件
cat /var/log/nginx/access.log | node analyze.mjs - -o report.html

# 将 /api/users/123、/api/users/456 合并为 /api/users/:id
node analyze.mjs access.log --normalize-ids

# 运行测试
npm test
```

直接在浏览器打开生成的 HTML，无需启动服务器。输入路径中的通配符由 shell 展开，例如 `node analyze.mjs /var/log/nginx/access.log*`。不要同时传入相互重叠的日志，工具不做请求去重。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-o, --output` | `report.html` | HTML 路径，自动创建父目录 |
| `--json` | 不输出 | 额外保存结构化统计数据 |
| `--slow-ms` | `1000` | 慢请求阈值，毫秒，包含等于阈值的请求 |
| `--top` | `20` | 保留耗时最高的请求条数，不限于慢请求 |
| `--normalize-ids` | 关闭 | 将完整数字和 UUID 路径段替换为 `:id` |
| `-h, --help` | | 查看帮助 |

## 日志格式

支持问题中使用的 ISO 8601 时间与以下格式，末尾四个计时字段可调整顺序，也可缺失。前缀结构需要一致，不支持未经修改的其他 combined 格式或 JSON 日志。

```nginx
log_format timings '$remote_addr [$time_iso8601] '
                   '"$request" $status $body_bytes_sent '
                   '"$http_referer" "$http_user_agent" '
                   'rt=$request_time uct="$upstream_connect_time" '
                   'uht="$upstream_header_time" urt="$upstream_response_time"';

access_log /var/log/nginx/access_timing.log timings;
```

日志中的耗时单位是秒，报告统一换算为毫秒。支持 UTF-8 / CRLF、普通文本和 `.gz` 文件；格式错误的行跳过并计数。没有有效请求时返回非零退出码，不生成报告。

## 报告内容

- 总请求量、接口数、平均耗时、P95/P99、慢请求比例、5xx 错误率和累计耗时。
- RT、UCT、UHT、URT 及派生差值的样本数、缺失数、均值、最小值、P50/P90/P95/P99、最大值。
- 按 HTTP 方法 + 去掉查询参数的原始路径聚合；接口表支持搜索、慢接口过滤和排序。
- 按累计 RT 贡献排序的优先排查接口，以及请求耗时 Top 明细。
- 完成时间流量图、平均耗时、阶段均值、状态码分布、重试及异常数据质量。

### 指标含义

| 指标 | 含义 | 排查方向 |
| --- | --- | --- |
| RT | Nginx 整个请求的耗时 | 客户端收发、Nginx、上游共同影响 |
| UCT | 建立上游连接的耗时，HTTPS 含握手 | 网络、连接复用、TLS、连接队列 |
| UHT | 从上游计时开始到收到响应头 | 包含连接阶段，不能当作纯应用耗时 |
| URT | 收到上游响应的耗时 | 包含连接及响应头阶段 |
| UHT − UCT | 近似首包等待差值 | 应用排队、数据库或外部依赖，需 tracing 验证 |
| URT − UHT | 近似响应体接收差值 | 大响应、流式输出、上游传输 |
| RT − URT | 请求总耗时与上游耗时差 | 客户端上传/下载、代理处理或限速等 |

**UCT、UHT、URT 存在包含关系，不应直接相加。仅凭 access log 不能区分数据库、CPU、锁等待或第三方服务耗时，也不能精确重建网络与应用阶段。**

### 统计口径

- 分位数采用精确的 nearest-rank：排序后取第 `ceil(n × p)` 个观测值。缺失值不参与统计，也不填零；不同指标的样本量可能不同。
- 慢请求率的分母为有效 RT 数；5xx / 4xx 比例的分母为有效请求数。4xx 不并入服务端错误率。
- 多次上游尝试（`0.001, 0.002`）和内部重定向组（`0.001 : 0.002`）逐项求和。某个计时列表含 `-` 或非法值时，该项整体视为缺失，避免低估；多次尝试不计算阶段差值。
- 单次尝试的负差在 2 ms 容差内归零，超过容差时该差值排除并标记时序异常；原始计时仍保留。
- 自动诊断是启发式规则：UCT P95 ≥ 50 ms；首包等待 P95 ≥ 慢阈值的 50%；响应体接收 / 请求阶段差值 P95 ≥ 慢阈值的 30%。5xx 和多次尝试另行提示。
- 小于 100 个有效 RT 样本时报告提示小样本风险；P95/P99 可能等同最大值，不能据此认定稳定瓶颈。
- 图表按日志完成时间的分钟桶统计；长窗口自动合并为最多约 90 个时间桶。时间统一显示为北京时间，不推算瞬时并发量。
- 累计 RT 可以体现“高频且慢”的优化优先级，但不是 CPU 时间，不等于观测窗口长度。

## 当前样本的结论

示例保留了原始 10 条请求的方法、路径、时间、状态、字节数和耗时，仅将 IP、Referer、UA 与查询值替换为演示数据。

| 项目 | 结果 |
| --- | --- |
| 请求 / 接口 | 10 / 9 |
| 平均 RT | 672.6 ms |
| P95 / P99 RT | 2293 / 2293 ms |
| 慢请求（≥ 1000 ms） | 2 次，20% |
| 最大 UCT | 1 ms |
| `GET /api/order/query_seq_type/` | RT 2293 ms，UHT / URT 2282 ms |
| `GET /api/sample/get_receive_sample_list/` | 2 次请求，RT 2240 / 730 ms，累计 RT 2970 ms |

两条慢请求的连接建立均很快，UHT 与 URT 接近，优先关联上游应用的首包等待，检查慢 SQL、应用排队及外部依赖。`query_seq_type` 返回约 197.3 KiB，但响应头到响应完成差值为 0 ms，当前日志并不支持“主要慢在响应体传输”的结论。只有 10 个请求，不能推断持续瓶颈。

## 大文件与隐私

文件逐行读取，不保留原始日志；为精确分位数会保留有效计时数值，内存随请求量增长，排序也有成本，并非恒定内存算法。大日志可分时间窗口运行，或适当增加 Node 堆上限：

```bash
node --max-old-space-size=4096 analyze.mjs access.log -o report.html
```

合并多个日志时按合并后的请求计算分位数，不能用各文件 P95 的平均值代替。此工具面向批量离线分析，不是持续运行的监控系统。

HTML 与 JSON 不包含查询参数、IP、Referer、UA 或原始日志行，但仍包含请求路径。**路径本身可能携带姓名、token 等敏感信息，数字 / UUID 归一化也不能覆盖所有敏感路径，分享报告前仍需审核。** HTML 会转义路径并保护嵌入 JSON，防止日志中的恶意字符串变成可执行代码。