# AI 运营管理平台 · 演示版 v2.1

选型交流用演示平台（React + TypeScript + Vite 构建产物 + 只读采集脚本）。

- 启动：Windows 双击 `start.bat`；Mac/Linux `./start.sh`；通用 `python serve.py`
- 页面：三中心（算力 / 模型 / 应用）+ 运营分析 + 投屏汇报首页，暗色大屏
- v2.1 口径：昇腾卡指标 **Prometheus 优先 + npu-smi 自动兜底**；容器平台 **执行回执接口已确认可提供**，采集层取回的回执直接驱动部署工单生效登记
- 接内网真实数据：`collector/collect.py`（只读，Python 标准库），字段字典与待确认接口见 `docs/intranet-api-checklist.md`
- 演示账号免密：管理员 A（管理员）/ 运营 B（运营值班）/ 开发者 C（业务开发者）/ 用户 D（业务用户）

详细说明见 `README-START.txt` 与 `docs/` 下文档。
