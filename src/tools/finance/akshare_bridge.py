#!/usr/bin/env python3
"""
Dexter AKShare stdio bridge - reads JSON commands from stdin, writes JSON responses to stdout.

Command format: {"method": "spot", "ticker": "601138"}
Response: {"data": {...}, "url": "..."} or {"error": "..."}
"""
import json, sys, time, traceback, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

try:
    import akshare as ak
except ImportError:
    json.dump({"error": "akshare not installed"}, sys.stdout)
    sys.stdout.write("\n"); sys.stdout.flush()
    sys.exit(1)

def sf(v):
    try: return float(v) if v is not None and str(v) != "nan" else None
    except: return None

def nt(ticker):
    t = ticker.strip().upper().replace(".SH","").replace(".SZ","")
    if t.startswith("SH") or t.startswith("SZ"): t = t[2:]
    if len(t)==6 and t.isdigit():
        return (t, "sh"+t) if t.startswith(("60","68")) else (t, "sz"+t)
    return (t, "sz"+t)

# === Command handlers ===

def cmd_spot(ticker):
    c,_ = nt(ticker)
    df = ak.stock_zh_a_spot_em()
    m = df[df["代码"]==c]
    if m.empty: return {"error": f"Ticker not found: {ticker}"}
    r = m.iloc[0].to_dict()
    return {"data":{"snapshot":{
        "ticker":c, "name":str(r["名称"]), "price":sf(r["最新价"]), "open":sf(r["今开"]),
        "high":sf(r["最高"]), "low":sf(r["最低"]), "close":sf(r["最新价"]),
        "change_pct":sf(r["涨跌幅"]), "volume":sf(r["成交量"]), "turnover":sf(r["成交额"]),
        "market_cap":sf(r["总市值"]), "pe_ratio":sf(r["市盈率-动态"]), "currency":"CNY"
    }},"url":f"akshare://spot/{c}"}

def cmd_hist(ticker, start_date, end_date, interval="day"):
    c,_ = nt(ticker)
    pm = {"day":"daily","week":"weekly","month":"monthly"}
    p = pm.get(interval,"daily")
    df = ak.stock_zh_a_hist(symbol=c, period=p,
                            start_date=start_date.replace("-",""),
                            end_date=end_date.replace("-",""), adjust="qfq")
    prices = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        prices.append({"date":str(rd["日期"]), "open":sf(rd["开盘"]), "close":sf(rd["收盘"]),
                       "high":sf(rd["最高"]), "low":sf(rd["最低"]), "volume":sf(rd["成交量"]),
                       "change_pct":sf(rd.get("涨跌幅")), "currency":"CNY"})
    return {"data":{"prices":prices},"url":f"akshare://hist/{c}"}

def cmd_tickers():
    df = ak.stock_info_a_code_name()
    return {"data":{"tickers":list(df["code"].astype(str))},"url":"akshare://tickers/"}

def cmd_income(ticker, period="annual", limit=4):
    _,sid = nt(ticker)
    df = ak.stock_financial_report_sina(stock=sid, symbol="利润表")
    records = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        records.append({"report_period":str(rd["报告日"]),"revenue":sf(rd["营业总收入"]),
                        "operating_income":sf(rd["营业利润"]),"net_income":sf(rd["净利润"]),
                        "earnings_per_share":sf(rd["基本每股收益"]),"currency":"CNY"})
    if period=="annual": records = [r for r in records if r["report_period"].endswith("1231")]
    return {"data":{"income_statements":records[:limit]},"url":f"akshare://income/{sid}"}

def cmd_balance(ticker, period="annual", limit=4):
    _,sid = nt(ticker)
    df = ak.stock_financial_report_sina(stock=sid, symbol="资产负债表")
    records = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        records.append({"report_period":str(rd["报告日"]),"total_assets":sf(rd["资产总计"]),
                        "total_liabilities":sf(rd["负债合计"]),
                        "shareholders_equity":sf(rd["归属于母公司股东权益合计"]),
                        "cash_and_equivalents":sf(rd["货币资金"]),
                        "short_term_debt":sf(rd["短期借款"]),"long_term_debt":sf(rd["长期借款"]),
                        "currency":"CNY"})
    if period=="annual": records = [r for r in records if r["report_period"].endswith("1231")]
    return {"data":{"balance_sheets":records[:limit]},"url":f"akshare://balance/{sid}"}

def cmd_cashflow(ticker, period="annual", limit=4):
    _,sid = nt(ticker)
    df = ak.stock_financial_report_sina(stock=sid, symbol="现金流量表")
    records = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        rec = {"report_period":str(rd["报告日"]),"currency":"CNY"}
        if "经营活动产生的现金流量净额" in rd: rec["operating_cash_flow"] = sf(rd["经营活动产生的现金流量净额"])
        if "投资活动产生的现金流量净额" in rd: rec["investing_cash_flow"] = sf(rd["投资活动产生的现金流量净额"])
        if "筹资活动产生的现金流量净额" in rd: rec["financing_cash_flow"] = sf(rd["筹资活动产生的现金流量净额"])
        records.append(rec)
    if period=="annual": records = [r for r in records if r["report_period"].endswith("1231")]
    return {"data":{"cash_flow_statements":records[:limit]},"url":f"akshare://cashflow/{sid}"}

def cmd_all_fin(ticker, period="annual", limit=4):
    inc = cmd_income(ticker, period, limit)
    bs = cmd_balance(ticker, period, limit)
    cf = cmd_cashflow(ticker, period, limit)
    return {"data":{"income_statements":inc["data"]["income_statements"],
                    "balance_sheets":bs["data"]["balance_sheets"],
                    "cash_flow_statements":cf["data"]["cash_flow_statements"]},
            "url":f"akshare://financials/{nt(ticker)[0]}"}

def cmd_metrics_snap(ticker):
    c,_ = nt(ticker)
    df = ak.stock_financial_analysis_indicator(symbol=c, start_year='2018')
    if df.empty: return {"error": f"No metrics for {ticker}"}
    r = df.iloc[-1].to_dict()
    return {"data":{"snapshot":{
        "report_date":str(r["日期"]),"eps":sf(r["摊薄每股收益(元)"]),
        "eps_adjusted":sf(r["每股收益_调整后(元)"]),
        "book_value_per_share":sf(r["每股净资产_调整前(元)"]),
        "roe":sf(r["净资产收益率(%)"]),"roe_weighted":sf(r["加权净资产收益率(%)"]),
        "roa":sf(r["总资产利润率(%)"]),"operating_margin":sf(r["营业利润率(%)"]),
        "net_margin":sf(r["销售净利率(%)"]),"gross_margin":sf(r["销售毛利率(%)"]),
        "revenue_growth":sf(r["主营业务收入增长率(%)"]),
        "net_income_growth":sf(r["净利润增长率(%)"]),
        "current_ratio":sf(r["流动比率"]),"quick_ratio":sf(r["速动比率"]),
        "asset_liability_ratio":sf(r["资产负债率(%)"]),
        "currency":"CNY"
    }},"url":f"akshare://metrics/{c}"}

def cmd_metrics_hist(ticker, period="annual", limit=4):
    c,_ = nt(ticker)
    df = ak.stock_financial_analysis_indicator(symbol=c, start_year='2018')
    records = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        records.append({"report_date":str(rd["日期"]),"eps":sf(rd["摊薄每股收益(元)"]),
                        "book_value_per_share":sf(rd["每股净资产_调整前(元)"]),
                        "roe":sf(rd["净资产收益率(%)"]),"roa":sf(rd["总资产利润率(%)"]),
                        "operating_margin":sf(rd["营业利润率(%)"]),
                        "net_margin":sf(rd["销售净利率(%)"]),
                        "revenue_growth":sf(rd["主营业务收入增长率(%)"]),
                        "net_income_growth":sf(rd["净利润增长率(%)"]),
                        "currency":"CNY"})
    if period=="annual":
        records = [r for r in records if r["report_date"].endswith("12-31")]
        records.sort(key=lambda r: r["report_date"], reverse=True)
    return {"data":{"financial_metrics":records[:limit]},"url":f"akshare://metrics-hist/{c}"}

def cmd_earnings(ticker=None, limit=10):
    if ticker:
        c,_ = nt(ticker)
        _,sid = nt(ticker)
        df = ak.stock_financial_report_sina(stock=sid, symbol="利润表")
        recs = []
        for _,r in df.head(limit).iterrows():
            rd = r.to_dict()
            recs.append({"ticker":c,"report_period":str(rd["报告日"]),
                         "revenue":sf(rd["营业总收入"]),"net_income":sf(rd["净利润"]),
                         "eps":sf(rd["基本每股收益"]),"currency":"CNY"})
        return {"data":{"earnings":recs},"url":f"akshare://earnings/{c}"}
    else:
        df = ak.stock_zh_a_spot_em().head(limit)
        feed = []
        for _,r in df.iterrows():
            rd = r.to_dict()
            feed.append({"ticker":str(rd["代码"]),"name":str(rd["名称"]),
                         "price":sf(rd["最新价"]),"change_pct":sf(rd["涨跌幅"]),
                         "pe_ratio":sf(rd["市盈率-动态"]),"market_cap":sf(rd["总市值"]),
                         "currency":"CNY"})
        return {"data":{"earnings":feed},"url":"akshare://earnings-feed/"}

def cmd_news(ticker=None, limit=5):
    try:
        if ticker:
            c,_ = nt(ticker)
            df = ak.stock_news_em(symbol=c).head(limit)
        else:
            df = ak.stock_news_em().head(limit)
        arts = []
        for _,r in df.iterrows():
            rd = r.to_dict()
            arts.append({"title":str(rd.get("标题","")),"date":str(rd.get("发布时间","")),
                         "source":str(rd.get("来源","")),"url":str(rd.get("新闻链接",""))})
        return {"data":{"news":arts},"url":"akshare://news/"}
    except:
        return {"data":{"news":[]},"url":"akshare://news/"}

def cmd_filings(ticker, limit=10):
    c,_ = nt(ticker)
    _,sid = nt(ticker)
    df = ak.stock_financial_report_sina(stock=sid, symbol="利润表").head(limit)
    fl = []
    for _,r in df.iterrows():
        rd = r.to_dict()
        pd = str(rd["报告日"])[:10]
        ft = "年报" if pd.endswith("1231") else ("中报" if pd.endswith("0630") else "季报")
        fl.append({"ticker":c,"report_period":pd,"filing_type":ft,
                   "revenue":sf(rd["营业总收入"]),"net_income":sf(rd["净利润"]),
                   "eps":sf(rd["基本每股收益"])})
    return {"data":{"filings":fl},"url":f"akshare://filings/{c}"}

def cmd_holders(ticker, limit=10):
    c,_ = nt(ticker)
    try:
        df = ak.stock_zh_a_gdhs(symbol=c).head(limit)
        h = []
        for _,r in df.iterrows():
            rd = r.to_dict()
            h.append({"ticker":c,"holder_name":str(rd["股东名称"]),
                      "holder_type":str(rd["股东类型"]),
                      "shares_held":sf(rd["持股数"]),"share_pct":sf(rd["持股比例(%)"])})
        return {"data":{"institutional_holdings":h},"url":f"akshare://holders/{c}"}
    except:
        return {"data":{"institutional_holdings":[]},"url":f"akshare://holders/{c}"}

# === Dispatch ===
HANDLERS = {
    "spot": cmd_spot,
    "hist": cmd_hist,
    "tickers": cmd_tickers,
    "income": cmd_income,
    "balance": cmd_balance,
    "cashflow": cmd_cashflow,
    "all_fin": cmd_all_fin,
    "metrics_snap": cmd_metrics_snap,
    "metrics_hist": cmd_metrics_hist,
    "earnings": cmd_earnings,
    "news": cmd_news,
    "filings": cmd_filings,
    "holders": cmd_holders,
}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            cmd = json.loads(line)
            method = cmd.get("method","")
            handler = HANDLERS.get(method)
            if not handler:
                result = {"error": f"Unknown method: {method}"}
            else:
                args = {k:v for k,v in cmd.items() if k != "method"}
                result = handler(**args)
        except Exception as e:
            result = {"error": str(e), "traceback": traceback.format_exc()}
        sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
