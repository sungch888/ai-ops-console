#!/usr/bin/env python3
"""Read-only telemetry collector for the AI ops platform demo (intranet build).

Pulls data from real systems when they are reachable, writes one flat JSON file
per source into the demo's `dist/data/` directory. The frontend reads those
files; if they are missing or stale it falls back to platform-derived numbers.

This collector NEVER writes to any external system. Blocking / deploy /
quota actions are always platform work orders, executed by the operator side.

Standard library only (urllib, json, subprocess). Sources are config-driven:
switching from demo fixtures to real endpoints is a config change, not a code
change.

Usage
  python3 collector/collect.py --config collector/config.example.json --once
  python3 collector/collect.py --config collector/config.json --loop 30
  python3 collector/collect.py --selftest          # write schema-shaped demo data
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

FIELDS = {
    "cards.json": ["node", "card_id", "model", "pool", "util_pct", "hbm_used_gb", "hbm_total_gb",
                   "temp_c", "power_w", "health", "service", "ecc_errors"],
    "services.json": ["service", "model", "version", "pool", "instances", "ready", "cards", "qps",
                      "tokens_per_sec", "ttft_ms", "p99_ms", "queue_depth", "kv_hit_pct",
                      "hbm_pct", "err_pct", "restarts"],
    "gateway.json": ["key_id", "holder", "app", "model", "channel", "kind", "rpm_limit", "used_rpm",
                     "tpm_limit", "spend_day", "requests", "errors", "fallbacks", "status"],
    "routes.json": ["model", "channel", "weight", "rpm", "tokens_wan", "err_pct", "health"],
    "apps.json": ["platform", "name", "type", "status", "owner", "updated_at", "models", "metric",
                  "on_platform"],
    "deploy.json": ["order_id", "result", "instances", "image", "nodes", "finished_at", "note"],
}
FILES = list(FIELDS.keys())


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg))


def http_json(url, headers=None, timeout=8, method="GET", body=None):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "aiops-demo-collector/1.0")
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        if v:
            req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "ignore")
    return json.loads(raw) if raw.strip().startswith(("{", "[")) else raw


def text_of(url, headers=None, timeout=8):
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "aiops-demo-collector/1.0")
    for k, v in (headers or {}).items():
        if v:
            req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def env_or(cfg, key, default=""):
    v = cfg.get(key, default)
    if isinstance(v, str) and v.startswith("env:"):
        return os.environ.get(v[4:], "")
    return v


# ----------------------------------------------------------------- sources ---
def _cards_npu_smi(cfg):
    """Local npu-smi parse. Field order must match the installed driver version."""
    out = []
    if True:
        # npu-smi info table -> rows. Field names must be confirmed per driver version.
        cmd = cfg.get("command", "npu-smi info")
        txt = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20).stdout
        for line in txt.splitlines():
            cells = [c for c in re.split(r"\s+", line.strip()) if c]
            if len(cells) < 8 or not re.match(r"^\d+$", cells[0]):
                continue
            out.append({
                "node": cfg.get("node", "local-node"),
                "card_id": "Card %s" % cells[1],
                "model": cells[2] if len(cells) > 2 else "Ascend 910B",
                "pool": cfg.get("pool", "shared"),
                "util_pct": int(float(cells[3])),
                "hbm_used_gb": float(cells[4]),
                "hbm_total_gb": float(cells[5]) if len(cells) > 5 else 32.0,
                "temp_c": int(float(cells[6])) if len(cells) > 6 else 0,
                "power_w": int(float(cells[7])) if len(cells) > 7 else 0,
                "health": "ok",
                "service": "",
                "ecc_errors": 0,
            })
        return out

def _cards_prometheus(cfg):
    """Prometheus query against the NPU exporter."""
    out = []
    base = env_or(cfg, "prometheus")
    if not base:
        raise RuntimeError("prometheus base url not configured")
    query = cfg.get("query", 'DCGM_FI_DEV_GPU_UTIL')
    rows = http_json("%s/api/v1/query?query=%s" % (base.rstrip("/"), urllib.parse.quote(query)))
    res = rows.get("data", {}).get("result", []) if isinstance(rows, dict) else []
    for item in res:
        m = item.get("metric", {})
        val = float(item.get("value", [0, 0])[1])
        out.append({
            "node": m.get("node", m.get("instance", "unknown")),
            "card_id": "Card %s" % m.get("gpu", m.get("npu", "0")),
            "model": m.get("model", "Ascend 910B"),
            "pool": m.get("pool", cfg.get("pool", "shared")),
            "util_pct": int(val),
            "hbm_used_gb": 0.0,
            "hbm_total_gb": 32.0,
            "temp_c": 0,
            "power_w": 0,
            "health": "ok" if val < 99 else "warn",
            "service": m.get("service", ""),
            "ecc_errors": 0,
        })
    if out:
        # enrich with HBM / temp / power from the extra queries when available
        extra = {
            "hbm_used_gb": cfg.get("query_hbm", 'DCGM_FI_DEV_FB_USED'),
            "temp_c": cfg.get("query_temp", 'DCGM_FI_DEV_GPU_TEMP'),
            "power_w": cfg.get("query_power", 'DCGM_FI_DEV_POWER_USAGE'),
        }
        for key, q in extra.items():
            try:
                r2 = http_json("%s/api/v1/query?query=%s" % (base.rstrip("/"), urllib.parse.quote(q)))
                for item in r2.get("data", {}).get("result", []):
                    m = item.get("metric", {})
                    vid = "%s:Card %s" % (m.get("node", m.get("instance", "unknown")),
                                          m.get("gpu", m.get("npu", "0")))
                    for row in out:
                        if "%s:%s" % (row["node"], row["card_id"]) == vid:
                            row[key] = round(float(item.get("value", [0, 0])[1]), 1)
            except Exception as e:  # missing exporter metric is expected, keep blank
                log("cards: extra metric %s unavailable (%s)" % (key, e))
    return out


def collect_cards(cfg):
    """cards: Prometheus first, npu-smi as fallback. mode = prometheus | npu-smi | both."""
    mode = cfg.get("mode", "prometheus")
    if mode == "npu-smi":
        return _cards_npu_smi(cfg)
    try:
        rows = _cards_prometheus(cfg)
        if rows:
            return rows
        log("cards: prometheus returned no rows; falling back to npu-smi")
    except Exception as e:
        log("cards: prometheus unavailable (%s); falling back to npu-smi" % e)
    if mode == "prometheus" and not cfg.get("fallback", True):
        raise RuntimeError("prometheus unavailable and npu-smi fallback disabled")
    fb = dict(cfg)
    fb["mode"] = "npu-smi"
    rows = _cards_npu_smi(fb)
    if not rows:
        raise RuntimeError("both sources empty: prometheus query and npu-smi parse")
    log("cards: served by npu-smi fallback")
    return rows


def parse_prom_text(txt):
    """Parse Prometheus text exposition into {name: [(labels, value), ...]}."""
    out = {}
    for line in txt.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r'^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$', line)
        if not m:
            continue
        name, labels, value = m.group(1), m.group(2) or "", float(m.group(3))
        d = {}
        for kv in re.findall(r'(\w+)="([^"]*)"', labels):
            d[kv[0]] = kv[1]
        out.setdefault(name, []).append((d, value))
    return out


def collect_services(cfg):
    url = env_or(cfg, "metrics_url", "http://127.0.0.1:8081/metrics")
    txt = text_of(url, timeout=int(cfg.get("timeout", 8)))
    metrics = parse_prom_text(txt)
    services = {}

    def pick(name, label="model_name"):
        for (labels, value) in metrics.get(name, []):
            yield labels, value

    for name, labels in [("qps", ["model_name"]), ("ttft_ms", ["model_name"])]:
        pass
    for metric in metrics:
        for labels, value in metrics[metric]:
            svc = labels.get("service") or labels.get("model_name") or labels.get("model") or "default"
            row = services.setdefault(svc, {
                "service": svc, "model": labels.get("model_name", svc),
                "version": labels.get("version", ""), "pool": labels.get("pool", cfg.get("pool", "shared")),
                "instances": 0, "ready": 0, "cards": 0, "qps": 0.0, "tokens_per_sec": 0.0,
                "ttft_ms": 0.0, "p99_ms": 0.0, "queue_depth": 0, "kv_hit_pct": 0.0,
                "hbm_pct": 0.0, "err_pct": 0.0, "restarts": 0,
            })
            low = metric.lower()
            if "request" in low or "qps" in low or "throughput_requests" in low:
                row["qps"] = round(row["qps"] + value, 2)
            elif "token" in low and ("per_sec" in low or "rate" in low or "throughput" in low):
                row["tokens_per_sec"] = round(row["tokens_per_sec"] + value, 1)
            elif "first_token" in low or "ttft" in low:
                row["ttft_ms"] = round(max(row["ttft_ms"], value * (1000 if value < 10 else 1)), 1)
            elif "latency" in low and ("p99" in low or "quantile" in low):
                row["p99_ms"] = round(max(row["p99_ms"], value * (1000 if value < 10 else 1)), 1)
            elif "queue" in low:
                row["queue_depth"] = int(max(row["queue_depth"], value))
            elif "cache" in low and ("hit" in low or "usage" in low):
                row["kv_hit_pct"] = round(max(row["kv_hit_pct"], value * (100 if value <= 1 else 1)), 1)
            elif "memory" in low or "hbm" in low or "vram" in low:
                row["hbm_pct"] = round(max(row["hbm_pct"], value * (100 if value <= 1 else 1)), 1)
            elif "error" in low or "fail" in low or "exception" in low:
                row["err_pct"] = round(row["err_pct"] + value * (100 if value <= 1 else 1), 2)
            elif "instance" in low or "replica" in low:
                row["instances"] = int(max(row["instances"], value))
    rows = list(services.values())
    for r in rows:
        r["instances"] = r["instances"] or 1
        r["ready"] = r["instances"]
        r["cards"] = int(cfg.get("cards_per_instance", 1)) * r["instances"]
    return rows


def collect_gateway(cfg):
    base = env_or(cfg, "base").rstrip("/")
    key = env_or(cfg, "master_key")
    if not base:
        raise RuntimeError("litellm base url not configured")
    headers = {"Authorization": "Bearer %s" % key} if key else {}
    keys_info = http_json("%s/key/info" % base, headers, timeout=10)
    spend = {}
    try:
        logs = http_json("%s/spend/logs?start_date=%s" % (
            base, datetime.now().strftime("%Y-%m-%d")), headers, timeout=15)
        for row in logs if isinstance(logs, list) else []:
            k = row.get("api_key") or row.get("token") or ""
            s = spend.setdefault(k, {"spend": 0.0, "requests": 0, "tokens": 0, "errors": 0})
            s["spend"] += float(row.get("spend") or 0)
            s["requests"] += 1
            s["tokens"] += int(row.get("total_tokens") or 0)
            if (row.get("error") or row.get("status") or "").lower() not in ("", "ok", "success"):
                s["errors"] += 1
    except Exception as e:
        log("litellm: /spend/logs unavailable (%s);\u7528\u91cf\u53ea\u53d6 key/info" % e)

    items = keys_info.get("user_info") or keys_info.get("keys") or keys_info if isinstance(keys_info, dict) else keys_info
    if isinstance(items, dict):
        items = list(items.values())
    rows = []
    for k in items if isinstance(items, list) else []:
        kid = k.get("token") or k.get("key") or k.get("key_alias") or ""
        if not kid:
            continue
        s = spend.get(kid, {"spend": 0.0, "requests": 0, "tokens": 0, "errors": 0})
        limit = k.get("rpm_limit") or k.get("max_budget") or 0
        rows.append({
            "key_id": (k.get("key_alias") or kid)[:12],
            "holder": k.get("user_alias") or k.get("team_id") or "",
            "app": k.get("metadata", {}).get("app", "") if isinstance(k.get("metadata"), dict) else "",
            "model": ",".join(k.get("models", []) if isinstance(k.get("models"), list) else [k.get("model", "")]),
            "channel": ",".join(k.get("litellm_key_name", []) if isinstance(k.get("litellm_key_name"), list) else [k.get("litellm_key_name", "")]) or "local",
            "kind": "\u4e2a\u4eba\u5bc6\u94a5" if k.get("key_type") == "individual" else "\u5e73\u53f0\u4ee3\u7406",
            "rpm_limit": int(limit or 0),
            "used_rpm": 0,
            "tpm_limit": str(k.get("tpm_limit") or ""),
            "spend_day": round(s["spend"], 2),
            "requests": s["requests"],
            "errors": s["errors"],
            "fallbacks": 0,
            "status": "off" if k.get("blocked") else "ok",
        })
    return rows


def collect_routes(cfg):
    base = env_or(cfg, "base").rstrip("/")
    key = env_or(cfg, "master_key")
    headers = {"Authorization": "Bearer %s" % key} if key else {}
    info = http_json("%s/model/info" % base, headers, timeout=10)
    data = info.get("data", info) if isinstance(info, dict) else info
    rows = []
    for m in data if isinstance(data, list) else []:
        rows.append({
            "model": m.get("model_name") or m.get("model_info", {}).get("model_name", ""),
            "channel": m.get("litellm_params", {}).get("api_base", "local"),
            "weight": int(m.get("litellm_params", {}).get("weight", 1) or 1),
            "rpm": 0,
            "tokens_wan": 0.0,
            "err_pct": 0.0,
            "health": "ok",
        })
    return rows


def collect_apps(cfg):
    """Phase 1: application list + publish status only. Read-only accounts."""
    rows = []
    dify = cfg.get("dify", {})
    if dify.get("base"):
        headers = {}
        token = env_or(dify, "api_key")
        if not token and dify.get("login"):
            try:
                res = http_json("%s/login" % dify["base"].rstrip("/"), {"Content-Type": "application/json"},
                                timeout=10, method="POST",
                                body={"email": dify.get("email", ""), "password": env_or(dify, "password"),
                                      "language": "zh-Hans"})
                token = res.get("data", {}).get("access_token", "") if isinstance(res, dict) else ""
            except Exception as e:
                log("dify: login failed (%s)" % e)
        if token:
            headers["Authorization"] = "Bearer %s" % token
            try:
                apps = http_json("%s/apps?page=1&limit=100" % dify["base"].rstrip("/"), headers, timeout=15)
                data = apps.get("data", []) if isinstance(apps, dict) else apps
                for a in data if isinstance(data, list) else []:
                    rows.append({
                        "platform": "Dify",
                        "name": a.get("name", ""),
                        "type": {"chat": "\u5bf9\u8bdd\u5e94\u7528\uff08Chat\uff09", "agent-chat": "Agent", "workflow": "\u5de5\u4f5c\u6d41\uff08Workflow\uff09",
                                 "completion": "\u6587\u672c\u751f\u6210"}.get(a.get("mode", ""), a.get("mode", "")),
                        "status": "\u5df2\u53d1\u5e03" if a.get("status") == "normal" or a.get("published") else "\u8349\u7a3f",
                        "owner": a.get("created_by", "") or cfg.get("owner", ""),
                        "updated_at": (a.get("updated_at") or "")[:16],
                        "models": a.get("model_config", {}).get("model", {}).get("name", "") if isinstance(a.get("model_config"), dict) else "",
                        "metric": "",
                        "on_platform": False,
                    })
            except Exception as e:
                log("dify: /apps failed (%s)" % e)
    rag = cfg.get("ragflow", {})
    if rag.get("base"):
        token = env_or(rag, "api_token")
        headers = {"Authorization": "Bearer %s" % token} if token else {}
        for path, kind in [("/api/v1/datasets", "\u6570\u636e\u96c6"), ("/api/v1/chats", "\u77e5\u8bc6\u5e93\u95ee\u7b54\uff08Chat\uff09"),
                           ("/api/v1/agents", "Agent")]:
            try:
                res = http_json("%s%s?page=1&page_size=100" % (rag["base"].rstrip("/"), path), headers, timeout=15)
                data = res.get("data", []) if isinstance(res, dict) else []
                if isinstance(data, dict):
                    data = data.get("items", []) or data.get("chats", []) or data.get("canvas", [])
                for a in data if isinstance(data, list) else []:
                    rows.append({
                        "platform": "RAGFlow",
                        "name": a.get("name", ""),
                        "type": kind,
                        "status": "\u5df2\u53d1\u5e03" if a.get("available") or a.get("release") else "\u5df2\u4e0b\u7ebf",
                        "owner": a.get("created_by", "") or cfg.get("owner", ""),
                        "updated_at": (a.get("update_date") or a.get("create_date") or "")[:16],
                        "models": a.get("embd_id", "") or "",
                        "metric": "\u6587\u6863 %s \u7bc7" % a.get("document_count", 0) if a.get("document_count") is not None else "",
                        "on_platform": False,
                    })
            except Exception as e:
                log("ragflow: %s failed (%s)" % (path, e))
    return rows


def collect_deploy(cfg):
    """Deployment receipts are written back by the container platform. Two options:
    an HTTP endpoint that returns pending receipts, or a local drop file."""
    if cfg.get("drop_file"):
        with open(cfg["drop_file"], "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    base = env_or(cfg, "base")
    if not base:
        raise RuntimeError("\u5bb9\u5668\u5e73\u53f0\u56de\u6267\u63a5\u53e3\u672a\u914d\u7f6e\uff08\u586b deploy.base \u6216\u6539\u7528 drop_file\uff09")
    res = http_json("%s?status=done" % base.rstrip("/"), {"Authorization": "Bearer %s" % env_or(cfg, "token")}, timeout=10)
    data = res.get("data", res) if isinstance(res, dict) else res
    rows = []
    for r in data if isinstance(data, list) else []:
        rows.append({
            "order_id": r.get("order_id") or r.get("ticket") or "",
            "result": "\u6210\u529f" if str(r.get("result", "")).lower() in ("ok", "success", "done") else "\u5931\u8d25",
            "instances": r.get("instances", ""),
            "image": r.get("image", ""),
            "nodes": r.get("nodes", ""),
            "finished_at": r.get("finished_at", ""),
            "note": r.get("note", ""),
        })
    return rows


SOURCE_FN = {
    "cards.json": collect_cards,
    "services.json": collect_services,
    "gateway.json": collect_gateway,
    "routes.json": collect_routes,
    "apps.json": collect_apps,
    "deploy.json": collect_deploy,
}


def write_out(out_dir, results, errors):
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for name, rows in results.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        files[name] = {"items": len(rows)}
        log("%s: %d rows" % (name, len(rows)))
    for name, err in errors.items():
        files[name] = {"items": 0, "error": str(err)}
        log("%s: FAILED (%s)" % (name, err))
    manifest = {
        "generatedAt": now_iso(),
        "collector": "aiops-demo-collector/1.0",
        "files": files,
        "note": "read-only pull; the platform never writes to these systems",
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)


def run_once(cfg, out_dir):
    results, errors = {}, {}
    for name in FILES:
        src = cfg.get(name.replace(".json", ""), cfg.get(name, {}))
        if not src or src.get("enabled") is False:
            errors[name] = "\u672a\u914d\u7f6e\u6216\u5df2\u7981\u7528\uff08\u5728 collector/config.json \u91cc\u5f00\u542f\uff09"
            continue
        try:
            rows = SOURCE_FN[name](src)
            if not rows:
                errors[name] = "\u63a5\u53e3\u5df2\u914d\u7f6e\u4f46\u672c\u8f6e\u6ca1\u53d6\u5230\u6570\u636e\uff08\u68c0\u67e5\u5730\u5740 / \u9274\u6743 / \u7f51\u6bb5\uff09"
            else:
                results[name] = rows
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            errors[name] = "\u8fde\u63a5\u5931\u8d25\uff1a%s" % e
        except Exception as e:
            errors[name] = "%s: %s" % (type(e).__name__, e)
    write_out(out_dir, results, errors)
    return results


def selftest(out_dir):
    """Schema-shaped sample data so the intranet demo runs before APIs are ready."""
    results = {
        "cards.json": [
            {"node": "AI-Infer-01", "card_id": "Card %d" % (i + 1), "model": "Ascend 910B3", "pool": "hp",
             "util_pct": 62 + i * 3, "hbm_used_gb": 18 + i, "hbm_total_gb": 32, "temp_c": 64 + i,
             "power_w": 240 + i * 6, "health": "ok" if i < 7 else "warn",
             "service": "Qwen3-32B" if i % 2 == 0 else "GLM-4-9B", "ecc_errors": i % 3}
            for i in range(8)
        ],
        "services.json": [
            {"service": "mindie-qwen3-32b", "model": "Qwen3-32B", "version": "v2.3", "pool": "hp",
             "instances": 4, "ready": 4, "cards": 8, "qps": 96.4, "tokens_per_sec": 4210, "ttft_ms": 268,
             "p99_ms": 712, "queue_depth": 18, "kv_hit_pct": 63.4, "hbm_pct": 78.2, "err_pct": 0.6, "restarts": 0},
            {"service": "mindie-glm-4-9b", "model": "GLM-4-9B", "version": "v4.9-1", "pool": "hp",
             "instances": 2, "ready": 2, "cards": 2, "qps": 31.2, "tokens_per_sec": 1180, "ttft_ms": 186,
             "p99_ms": 508, "queue_depth": 6, "kv_hit_pct": 71.0, "hbm_pct": 62.4, "err_pct": 0.4, "restarts": 0},
        ],
        "gateway.json": [
            {"key_id": "SA-0092", "holder": "\u5211\u4fa6\u603b\u961f \u00b7 \u5e73\u53f0\u4ee3\u7406", "app": "\u8b66\u60c5\u62a5\u544a\u64b0\u5199\u52a9\u624b", "model": "Qwen3-32B",
             "channel": "local-ascend", "kind": "\u5e73\u53f0\u4ee3\u7406", "rpm_limit": 400, "used_rpm": 361, "tpm_limit": "40\u4e07",
             "spend_day": 1864.4, "requests": 46080, "errors": 184, "fallbacks": 62, "status": "warn"},
            {"key_id": "SA-0117", "holder": "\u6cd5\u5236\u603b\u961f \u00b7 \u97e6\u00d7\u00d7", "app": "\u6cd5\u89c4\u77e5\u8bc6\u95ee\u7b54", "model": "BGE-M3",
             "channel": "local-ascend", "kind": "\u4e2a\u4eba\u5bc6\u94a5", "rpm_limit": 120, "used_rpm": 74, "tpm_limit": "12\u4e07",
             "spend_day": 214.6, "requests": 9120, "errors": 12, "fallbacks": 0, "status": "ok"},
        ],
        "routes.json": [
            {"model": "\u672c\u5730\u6607\u817e\u96c6\u7fa4", "channel": "local-ascend", "weight": 60, "rpm": 173, "tokens_wan": 2.1,
             "err_pct": 0.6, "health": "ok"},
            {"model": "\u5916\u90e8\u5927\u6a21\u578b API \u6e20\u9053", "channel": "vendor", "weight": 40, "rpm": 115, "tokens_wan": 1.4,
             "err_pct": 1.9, "health": "warn"},
        ],
        "apps.json": [
            {"platform": "Dify", "name": "\u63a5\u8bbf\u95ee\u7b54\u52a9\u624b", "type": "\u5bf9\u8bdd\u5e94\u7528\uff08Chatflow\uff09", "status": "\u5df2\u53d1\u5e03",
             "owner": "\u6cbb\u5b89\u603b\u961f", "updated_at": "11-04 16:20", "models": "GLM-4-9B", "metric": "4.5 \u4e07\u6b21/\u65e5",
             "on_platform": True},
            {"platform": "RAGFlow", "name": "\u6cd5\u89c4\u77e5\u8bc6\u95ee\u7b54", "type": "\u77e5\u8bc6\u5e93\u95ee\u7b54\uff08Chat\uff09", "status": "\u5df2\u53d1\u5e03",
             "owner": "\u6cd5\u5236\u603b\u961f", "updated_at": "11-04 18:05", "models": "BGE-M3 + Reranker",
             "metric": "\u6587\u6863 12,418 \u7bc7", "on_platform": True},
        ],
        "deploy.json": [
            {"order_id": "WO-0014", "result": "\u6210\u529f", "instances": "mindie-deepseek-0/1",
             "image": "mindie:2.1.deepseek", "nodes": "AI-Infer-03 / AI-Infer-04",
             "finished_at": now_iso(), "note": "\u5bb9\u5668\u5e73\u53f0\u81ea\u52a8\u56de\u6267\uff08\u6f14\u793a\u6837\u4f8b\uff09"},
        ],
    }
    write_out(out_dir, results, {})


def main():
    ap = argparse.ArgumentParser(description="AI ops demo read-only telemetry collector")
    ap.add_argument("--config", default="collector/config.json")
    ap.add_argument("--out", default="dist/data")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", type=int, default=0, help="seconds between rounds")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        log("selftest: writing schema-shaped sample data")
        selftest(args.out)
        return
    if not os.path.exists(args.config):
        log("config not found: %s (copy collector/config.example.json)" % args.config)
        sys.exit(2)
    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    log("sources: %s" % ", ".join(k for k in cfg if k in {f.split('.')[0] for f in FILES}))
    while True:
        run_once(cfg, args.out)
        if args.once or not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
