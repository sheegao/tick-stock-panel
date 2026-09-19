// Local, read-only TSP bridge for github.com/injoyai/tdx (MIT).
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/injoyai/ios"
	"github.com/injoyai/tdx"
	"github.com/injoyai/tdx/protocol"
)

var canonical = regexp.MustCompile(`^[0-9]{6}\.(SH|SZ|BJ)$`)
var units = map[string]string{"price": "yuan", "volume": "hands", "amount": "yuan", "depth_volume": "hands"}

type query struct {
	Op        string   `json:"op"`
	Symbols   []string `json:"symbols"`
	AssetType string   `json:"asset_type"`
	Start     string   `json:"start"`
	End       string   `json:"end"`
	Freq      string   `json:"freq"`
}
type bridge struct {
	cli      *tdx.Client
	hosts    []string
	gate     chan struct{}
	universe map[string][]map[string]any
	expires  time.Time
}

func codeFor(symbol string) (string, error) {
	if !canonical.MatchString(symbol) {
		return "", fmt.Errorf("invalid canonical symbol: %q", symbol)
	}
	return strings.ToLower(symbol[7:]) + symbol[:6], nil
}
func symbolFor(ex protocol.Exchange, code string) string {
	return code + "." + strings.ToUpper(ex.String())
}
func dailyRow(symbol string, k *protocol.Kline, _ string) map[string]any {
	return map[string]any{"symbol": symbol, "date": k.Time.Format("2006-01-02"),
		"open": k.Open.Float64(), "high": k.High.Float64(), "low": k.Low.Float64(),
		"close": k.Close.Float64(), "volume": float64(k.Volume), "amount": k.Amount.Float64()}
}
func minuteRow(symbol string, k *protocol.Kline, asset string) map[string]any {
	volume := float64(k.Volume)
	if asset == "index" {
		volume /= 100
	} // Undo the SDK's index-only *100 after its minute /100 normalization.
	return map[string]any{"symbol": symbol, "datetime": k.Time.Format("2006-01-02T15:04:05"),
		"open": k.Open.Float64(), "high": k.High.Float64(), "low": k.Low.Float64(),
		"close": k.Close.Float64(), "volume": volume, "amount": k.Amount.Float64()}
}
func quoteRow(q *protocol.Quote) map[string]any {
	k := q.Kline
	return map[string]any{"symbol": symbolFor(q.Exchange, q.Code), "last_price": k.Close.Float64(),
		"prev_close": k.Last.Float64(), "open": k.Open.Float64(), "high": k.High.Float64(),
		"low": k.Low.Float64(), "volume": float64(k.Volume), "amount": k.Amount.Float64(),
		"timestamp": nil, "source_time": q.ServerTime, "time_provenance": "trade_date_unavailable"}
}

func depthRow(q *protocol.Quote, received time.Time) (map[string]any, error) {
	if q == nil || q.Kline == nil || received.IsZero() {
		return nil, errors.New("invalid depth quote")
	}
	var bidPrices, askPrices [5]float64
	var bidVolumes, askVolumes [5]int
	for i := 0; i < 5; i++ {
		bidPrices[i] = q.BuyLevel[i].Price.Float64()
		askPrices[i] = q.SellLevel[i].Price.Float64()
		bidVolumes[i] = q.BuyLevel[i].Number
		askVolumes[i] = q.SellLevel[i].Number
		if bidPrices[i] < 0 || askPrices[i] < 0 || bidVolumes[i] < 0 || askVolumes[i] < 0 {
			return nil, errors.New("negative depth price or volume")
		}
	}
	return map[string]any{
		"symbol":               symbolFor(q.Exchange, q.Code),
		"bid_prices":           bidPrices,
		"ask_prices":           askPrices,
		"bid_volumes":          bidVolumes,
		"ask_volumes":          askVolumes,
		"timestamp":            received.UnixMilli(),
		"source_time":          q.ServerTime,
		"timestamp_provenance": "local_receive",
	}, nil
}

type adjEvent struct {
	dividend, allotPrice, bonus float64
	allot                       float64
}

func roundHalfUpCent(value float64) float64 {
	return math.Floor(value*100+0.5) / 100
}

func adjFactorRows(symbol string, events []*protocol.Gbbq, bars []*protocol.Kline, start, end string) ([]map[string]any, error) {
	for _, value := range []string{start, end} {
		if value != "" {
			if _, err := time.Parse("2006-01-02", value); err != nil {
				return nil, err
			}
		}
	}
	if start != "" && end != "" && start > end {
		return nil, errors.New("start after end")
	}
	cleanBars := make([]*protocol.Kline, 0, len(bars))
	for _, bar := range bars {
		if bar == nil || bar.Time.IsZero() || bar.Close <= 0 {
			return nil, errors.New("invalid daily bar for adjustment factor")
		}
		cleanBars = append(cleanBars, bar)
	}
	if len(cleanBars) == 0 {
		return nil, errors.New("empty daily history for adjustment factor")
	}
	sort.Slice(cleanBars, func(i, j int) bool { return cleanBars[i].Time.Before(cleanBars[j].Time) })
	latest := cleanBars[len(cleanBars)-1].Time.Format("2006-01-02")
	merged := map[string]*adjEvent{}
	for _, event := range events {
		if event == nil || event.Category != 1 {
			continue
		}
		day := event.Time.Format("2006-01-02")
		if (start != "" && day < start) || (end != "" && day > end) || day > latest {
			continue
		}
		xrxd := event.XRXD()
		values := []float64{xrxd.Fenhong, xrxd.Peigujia, xrxd.Songzhuangu, xrxd.Peigu}
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
				return nil, errors.New("invalid corporate action value")
			}
		}
		if xrxd.Fenhong == 0 && xrxd.Peigujia == 0 && xrxd.Songzhuangu == 0 && xrxd.Peigu == 0 {
			continue
		}
		item := merged[day]
		if item == nil {
			item = &adjEvent{}
			merged[day] = item
		}
		item.dividend += xrxd.Fenhong
		item.bonus += xrxd.Songzhuangu
		item.allot += xrxd.Peigu
		if xrxd.Peigujia > item.allotPrice {
			item.allotPrice = xrxd.Peigujia
		}
	}
	days := make([]string, 0, len(merged))
	for day, item := range merged {
		if item.dividend != 0 || item.bonus != 0 || item.allot != 0 {
			days = append(days, day)
		}
	}
	sort.Strings(days)
	rows := make([]map[string]any, 0, len(days))
	for _, day := range days {
		var previous *protocol.Kline
		for _, bar := range cleanBars {
			if bar.Time.Format("2006-01-02") >= day {
				break
			}
			previous = bar
		}
		if previous == nil {
			return nil, fmt.Errorf("missing previous raw close before %s", day)
		}
		item := merged[day]
		if item.allot > 0 && item.allotPrice <= 0 {
			return nil, fmt.Errorf("missing allotment price for %s", day)
		}
		prevClose := previous.Close.Float64()
		numerator := prevClose*10 - item.dividend + item.allot*item.allotPrice
		denominator := 10 + item.bonus + item.allot
		if numerator <= 0 || denominator <= 0 {
			return nil, fmt.Errorf("invalid adjustment formula for %s", day)
		}
		reference := roundHalfUpCent(numerator / denominator)
		factor := prevClose / reference
		if reference <= 0 || math.IsNaN(factor) || math.IsInf(factor, 0) || factor <= 0 {
			return nil, fmt.Errorf("invalid adjustment factor for %s", day)
		}
		rows = append(rows, map[string]any{"symbol": symbol, "trade_date": day, "ex_factor": factor})
	}
	return rows, nil
}

func readFactorBars(ctx context.Context, earliest string, fetch barFetch) ([]*protocol.Kline, error) {
	if _, err := time.Parse("2006-01-02", earliest); err != nil {
		return nil, err
	}
	bars := []*protocol.Kline{}
	for page := 0; page < 32; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		resp, err := fetch(uint16(page*800), 800)
		if err != nil {
			return nil, err
		}
		if resp == nil {
			return nil, errors.New("nil daily response for adjustment factor")
		}
		reached := false
		for _, bar := range resp.List {
			if bar == nil || bar.Time.IsZero() {
				return nil, errors.New("invalid daily bar for adjustment factor")
			}
			bars = append(bars, bar)
			if bar.Time.Format("2006-01-02") < earliest {
				reached = true
			}
		}
		if reached || resp.Count < 800 || len(resp.List) == 0 {
			return bars, nil
		}
	}
	return nil, errors.New("daily pagination bound reached for adjustment factor")
}

type barFetch func(uint16, uint16) (*protocol.KlineResp, error)

func readDaily(ctx context.Context, symbol, asset, start, end string, fetch barFetch) ([]map[string]any, error) {
	for _, s := range []string{start, end} {
		if s != "" {
			if _, err := time.Parse("2006-01-02", s); err != nil {
				return nil, err
			}
		}
	}
	if start != "" && end != "" && start > end {
		return nil, errors.New("start after end")
	}
	rows := []map[string]any{}
	// 32 pages * 800 bars (~100 trading years), never uint16-wrap or silently truncate.
	for page := 0; page < 32; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		resp, err := fetch(uint16(page*800), 800)
		if err != nil {
			return nil, err
		}
		if resp == nil {
			return nil, errors.New("nil bar response")
		}
		reached := false
		for _, k := range resp.List {
			if k == nil || k.Time.IsZero() {
				return nil, errors.New("invalid daily bar")
			}
			day := k.Time.Format("2006-01-02")
			if start != "" && day <= start {
				reached = true
			}
			if (start == "" || day >= start) && (end == "" || day <= end) {
				rows = append(rows, dailyRow(symbol, k, asset))
			}
		}
		if resp.Count < 800 || len(resp.List) == 0 || reached {
			return rows, nil
		}
	}
	return nil, errors.New("daily pagination bound reached; refusing truncated history")
}

func readMinute(ctx context.Context, symbol, asset, start, end string, fetch barFetch) ([]map[string]any, error) {
	const layout = "2006-01-02T15:04:05"
	for _, value := range []string{start, end} {
		if value != "" {
			if _, err := time.Parse(layout, value); err != nil {
				return nil, err
			}
		}
	}
	if start != "" && end != "" && start > end {
		return nil, errors.New("start after end")
	}
	rows := []map[string]any{}
	// The upstream protocol exposes at most 24,000 one-minute bars (30 pages).
	for page := 0; page < 30; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		resp, err := fetch(uint16(page*800), 800)
		if err != nil {
			return nil, err
		}
		if resp == nil {
			return nil, errors.New("nil minute response")
		}
		reached := false
		for _, k := range resp.List {
			if k == nil || k.Time.IsZero() {
				return nil, errors.New("invalid minute bar")
			}
			stamp := k.Time.Format(layout)
			if start != "" && stamp <= start {
				reached = true
			}
			if (start == "" || stamp >= start) && (end == "" || stamp <= end) {
				rows = append(rows, minuteRow(symbol, k, asset))
			}
		}
		if resp.Count < 800 || len(resp.List) == 0 || reached {
			return rows, nil
		}
	}
	return nil, errors.New("minute source bound reached; refusing truncated history")
}

func (b *bridge) connect(ctx context.Context) error {
	if b.cli != nil {
		return nil
	}
	var last error
	for _, host := range b.hosts {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !strings.Contains(host, ":") {
			host += ":7709"
		}
		addr := host
		cli, err := tdx.DialWith(func(_ context.Context) (ios.ReadWriteCloser, string, error) {
			c, e := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "tcp", addr)
			return c, addr, e
		}, tdx.WithRedial(false), tdx.WithDebug(false))
		if err != nil {
			last = err
			continue
		}
		cli.SetTimeout(3 * time.Second)
		// A TCP accept is insufficient: validate a real protocol response before ready.
		q, e := cli.GetQuote("sh600519")
		if e != nil || len(q) != 1 || q[0] == nil || q[0].Kline == nil {
			cli.Close()
			last = fmt.Errorf("quote probe failed: %v", e)
			continue
		}
		daily, e := cli.GetKlineDay("sh600519", 0, 1)
		if e != nil || daily == nil || len(daily.List) != 1 || daily.List[0] == nil {
			cli.Close()
			last = fmt.Errorf("daily probe failed: %v", e)
			continue
		}
		minute, e := cli.GetKlineMinute("sh600519", 0, 1)
		if e != nil || minute == nil || len(minute.List) != 1 || minute.List[0] == nil {
			cli.Close()
			last = fmt.Errorf("minute probe failed: %v", e)
			continue
		}
		gbbq, e := cli.GetGbbq("sh600519")
		validEvent := false
		if e == nil && gbbq != nil {
			for _, event := range gbbq.List {
				if event != nil && event.Category == 1 {
					validEvent = true
					break
				}
			}
		}
		if !validEvent {
			cli.Close()
			last = fmt.Errorf("corporate action probe failed: %v", e)
			continue
		}
		b.cli = cli
		log.Printf("TDX connected to %s", addr)
		return nil
	}
	return fmt.Errorf("no usable TDX host: %v", last)
}

func (b *bridge) bjCodes(ctx context.Context) ([]*protocol.Code, error) {
	// Upstream GetCodeAll(BJ) downloads zhb.zip without bounds. Add bounds here.
	const size = uint32(30000)
	raw := []byte{}
	for page := 0; page < 512; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value, err := b.cli.SendFrame(protocol.MBlock.FrameInfo(uint32(len(raw)), size, protocol.ReportZHB))
		if err != nil {
			return nil, err
		}
		part, ok := value.(*protocol.BlockInfoResp)
		if !ok || part == nil {
			return nil, errors.New("invalid BJ report response")
		}
		if len(part.Data) > int(size) {
			return nil, errors.New("oversized BJ report chunk")
		}
		raw = append(raw, part.Data...)
		if len(part.Data) < int(size) {
			zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
			if err != nil {
				return nil, err
			}
			for _, f := range zr.File {
				if f.Name != protocol.FileTdxBjMore {
					continue
				}
				if f.UncompressedSize64 > 4<<20 {
					return nil, errors.New("oversized BJ code file")
				}
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				data, err := io.ReadAll(io.LimitReader(rc, (4<<20)+1))
				rc.Close()
				if err != nil {
					return nil, err
				}
				if len(data) > 4<<20 {
					return nil, errors.New("oversized BJ code data")
				}
				codes := protocol.ParseTdxBjMore(data)
				if len(codes) == 0 {
					return nil, errors.New("empty BJ code universe")
				}
				return codes, nil
			}
			return nil, errors.New("BJ code file absent from report")
		}
	}
	return nil, errors.New("BJ report page bound reached")
}

func (b *bridge) instruments(ctx context.Context, asset string) ([]map[string]any, error) {
	if b.universe != nil && time.Now().Before(b.expires) {
		return b.universe[asset], nil
	}
	universe := map[string][]map[string]any{"stock": {}, "etf": {}, "index": {}}
	models := []*tdx.CodeModel{}
	for _, ex := range []protocol.Exchange{protocol.ExchangeSH, protocol.ExchangeSZ, protocol.ExchangeBJ} {
		codes := []*protocol.Code{}
		if ex == protocol.ExchangeBJ {
			var err error
			codes, err = b.bjCodes(ctx)
			if err != nil {
				return nil, err
			}
		} else {
			finished := false
			for page := 0; page < 66; page++ {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				resp, err := b.cli.GetCode(ex, uint16(page*1000))
				if err != nil {
					return nil, err
				}
				if resp == nil {
					return nil, errors.New("nil code response")
				}
				codes = append(codes, resp.List...)
				if resp.Count < 1000 {
					finished = true
					break
				}
			}
			if !finished {
				return nil, errors.New("code pagination bound reached")
			}
		}
		exchangeStocks := 0
		for _, c := range codes {
			if c == nil {
				return nil, errors.New("nil code metadata")
			}
			full := ex.String() + c.Code
			kind := ""
			switch {
			case protocol.IsStock(full):
				kind = "stock"
				exchangeStocks++
			case protocol.IsETF(full):
				kind = "etf"
			case protocol.IsIndex(full):
				kind = "index"
			}
			if kind == "" {
				continue
			}
			symbol := symbolFor(ex, c.Code)
			if _, err := codeFor(symbol); err != nil {
				return nil, err
			}
			if c.Name == "" {
				return nil, errors.New("empty security name")
			}
			universe[kind] = append(universe[kind], map[string]any{"symbol": symbol, "name": c.Name,
				"code": c.Code, "exchange": strings.ToUpper(ex.String()), "region": "CN", "type": kind, "ext": map[string]any{}})
			models = append(models, &tdx.CodeModel{Name: c.Name, Code: c.Code, Exchange: ex.String(), Decimal: c.Decimal, Multiple: c.Multiple})
		}
		if exchangeStocks == 0 {
			return nil, fmt.Errorf("empty stock universe for %s", ex)
		}
	}
	cs := tdx.NewCodesBase()
	cs.Update(models)
	tdx.DefaultCodes = cs // memory only, no SDK database/scheduler.
	b.universe = universe
	b.expires = time.Now().Add(time.Hour)
	return universe[asset], nil
}

func (b *bridge) query(ctx context.Context, q query) ([]map[string]any, error) {
	if q.Op != "daily" && q.Op != "minute" && q.Op != "quotes" && q.Op != "instruments" && q.Op != "adj_factors" && q.Op != "depth5" {
		return nil, errors.New("unsupported operation")
	}
	if q.AssetType == "" {
		q.AssetType = "stock"
	}
	if q.AssetType != "stock" && q.AssetType != "etf" && q.AssetType != "index" {
		return nil, errors.New("unsupported asset type")
	}
	limit := 80
	if q.Op == "daily" || q.Op == "minute" || q.Op == "adj_factors" {
		limit = 5
	}
	if q.Op != "instruments" && (len(q.Symbols) == 0 || len(q.Symbols) > limit) {
		return nil, errors.New("invalid symbol batch size")
	}
	codes := make([]string, len(q.Symbols))
	for i, s := range q.Symbols {
		code, err := codeFor(s)
		if err != nil {
			return nil, err
		}
		codes[i] = code
	}
	if err := b.connect(ctx); err != nil {
		return nil, err
	}
	if q.Op == "instruments" {
		return b.instruments(ctx, q.AssetType)
	}
	rows := []map[string]any{}
	if q.Op == "quotes" || q.Op == "depth5" {
		for _, c := range codes {
			if !protocol.IsStock(c) && !protocol.IsIndex(c) {
				if _, err := b.instruments(ctx, "etf"); err != nil {
					return nil, err
				}
				break
			}
		}
		quotes, err := b.cli.GetQuote(codes...)
		if err != nil {
			return nil, err
		}
		received := time.Now()
		for _, v := range quotes {
			if v == nil || v.Kline == nil {
				return nil, errors.New("nil quote")
			}
			if q.Op == "depth5" {
				row, err := depthRow(v, received)
				if err != nil {
					return nil, err
				}
				rows = append(rows, row)
			} else {
				rows = append(rows, quoteRow(v))
			}
		}
		return rows, nil
	}
	if q.Op == "adj_factors" {
		if q.AssetType != "stock" {
			return nil, errors.New("adjustment factors support stocks only")
		}
		for _, value := range []string{q.Start, q.End} {
			if value != "" {
				if _, err := time.Parse("2006-01-02", value); err != nil {
					return nil, err
				}
			}
		}
		if q.Start != "" && q.End != "" && q.Start > q.End {
			return nil, errors.New("start after end")
		}
		for i, code := range codes {
			if !protocol.IsStock(code) {
				return nil, fmt.Errorf("symbol %s is not a stock", q.Symbols[i])
			}
			resp, err := b.cli.GetGbbq(code)
			if err != nil || resp == nil {
				if err == nil {
					err = errors.New("nil corporate action response")
				}
				return nil, fmt.Errorf("corporate actions for %s: %w", q.Symbols[i], err)
			}
			earliest := ""
			for _, event := range resp.List {
				if event == nil || event.Category != 1 {
					continue
				}
				day := event.Time.Format("2006-01-02")
				if (q.Start == "" || day >= q.Start) && (q.End == "" || day <= q.End) && (earliest == "" || day < earliest) {
					earliest = day
				}
			}
			if earliest == "" {
				continue
			}
			bars, err := readFactorBars(ctx, earliest, func(offset, count uint16) (*protocol.KlineResp, error) {
				return b.cli.GetKlineDay(code, offset, count)
			})
			if err != nil {
				return nil, err
			}
			values, err := adjFactorRows(q.Symbols[i], resp.List, bars, q.Start, q.End)
			if err != nil {
				return nil, err
			}
			rows = append(rows, values...)
		}
		return rows, nil
	}
	if q.Op == "minute" && q.Freq != "1m" {
		return nil, errors.New("only 1m minute bars are supported")
	}
	for i, code := range codes {
		valid := q.AssetType == "stock" && protocol.IsStock(code) || q.AssetType == "etf" && protocol.IsETF(code) || q.AssetType == "index" && protocol.IsIndex(code)
		if !valid {
			return nil, fmt.Errorf("symbol %s does not match asset_type %s", q.Symbols[i], q.AssetType)
		}
		fetch := func(offset, count uint16) (*protocol.KlineResp, error) {
			if q.AssetType == "index" {
				if q.Op == "minute" {
					return b.cli.GetIndexMinute(code, offset, count)
				}
				return b.cli.GetIndexDay(code, offset, count)
			}
			if q.Op == "minute" {
				return b.cli.GetKlineMinute(code, offset, count)
			}
			return b.cli.GetKlineDay(code, offset, count)
		}
		var values []map[string]any
		var err error
		if q.Op == "minute" {
			values, err = readMinute(ctx, q.Symbols[i], q.AssetType, q.Start, q.End, fetch)
		} else {
			values, err = readDaily(ctx, q.Symbols[i], q.AssetType, q.Start, q.End, fetch)
		}
		if err != nil {
			return nil, err
		}
		rows = append(rows, values...)
	}
	return rows, nil
}

func jsonReply(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
func (b *bridge) serve(w http.ResponseWriter, r *http.Request) {
	host, _, hostErr := net.SplitHostPort(r.Host)
	if hostErr != nil || (host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback())) || r.Header.Get("Origin") != "" {
		jsonReply(w, 403, map[string]any{"error": "only local backend requests are allowed"})
		return
	}
	if r.URL.Path != "/query" && r.URL.Path != "/health" {
		http.NotFound(w, r)
		return
	}
	isHealth := r.URL.Path == "/health"
	if (isHealth && r.Method != "GET") || (!isHealth && r.Method != "POST") {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	timeout := 110 * time.Second
	if isHealth {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	select {
	case b.gate <- struct{}{}:
		defer func() { <-b.gate }()
	case <-ctx.Done():
		jsonReply(w, 503, map[string]any{"error": "bridge busy"})
		return
	}
	var rows []map[string]any
	var err error
	if isHealth {
		err = b.connect(ctx)
		if err == nil {
			_, err = b.cli.GetQuote("sh600519")
		}
	} else {
		var q query
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
		dec.DisallowUnknownFields()
		if e := dec.Decode(&q); e != nil {
			jsonReply(w, 400, map[string]any{"error": e.Error()})
			return
		}
		if e := dec.Decode(new(any)); e != io.EOF {
			jsonReply(w, 400, map[string]any{"error": "expected single JSON object"})
			return
		}
		rows, err = b.query(ctx, q)
	}
	if err != nil {
		if b.cli != nil {
			b.cli.Close()
			b.cli = nil
		}
		jsonReply(w, 503, map[string]any{"version": 1, "ready": false, "error": err.Error()})
		return
	}
	if isHealth {
		jsonReply(w, 200, map[string]any{"version": 1, "ready": true, "units": units,
			"features": []string{"adj_factor", "daily", "depth5", "minute", "realtime"}, "quote_trade_date": false,
			"adj_factor_kind": "single_event_ratio", "depth_timestamp": "local_receive"})
		return
	}
	jsonReply(w, 200, map[string]any{"version": 1, "rows": rows})
}

func main() {
	listen := flag.String("listen", "127.0.0.1:3020", "loopback HTTP listen address")
	hosts := flag.String("hosts", "", "comma-separated TDX host:port list (default first 8 upstream hosts)")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("listen must be a loopback IP:port")
	}
	list := tdx.Hosts
	if len(list) > 8 {
		list = list[:8]
	}
	if *hosts != "" {
		list = strings.Split(*hosts, ",")
	}
	b := &bridge{hosts: list, gate: make(chan struct{}, 1)}
	server := &http.Server{Addr: *listen, Handler: http.HandlerFunc(b.serve), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Printf("TDX read-only bridge listening at http://%s", *listen)
	log.Fatal(server.ListenAndServe())
}
