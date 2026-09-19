package main

import (
	"context"
	"math"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/injoyai/tdx"
	"github.com/injoyai/tdx/protocol"
)

func TestHTTPGuards(t *testing.T) {
	b := &bridge{gate: make(chan struct{}, 1)}
	for _, tc := range []struct {
		method, path, host, origin string
		status                     int
	}{
		{"GET", "/health", "evil.example:3020", "", 403},
		{"GET", "/health", "127.0.0.1:3020", "https://evil.example", 403},
		{"GET", "/query", "127.0.0.1:3020", "", 405},
		{"GET", "/missing", "127.0.0.1:3020", "", 404},
		{"POST", "/query", "127.0.0.1:3020", "", 400},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Host = tc.host
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		b.serve(w, r)
		if w.Code != tc.status {
			t.Fatalf("%+v: HTTP %d", tc, w.Code)
		}
	}
}

func TestSymbol(t *testing.T) {
	for in, want := range map[string]string{"600519.SH": "sh600519", "000001.SZ": "sz000001", "920001.BJ": "bj920001"} {
		got, err := codeFor(in)
		if err != nil || got != want {
			t.Fatalf("%s => %s, %v", in, got, err)
		}
	}
	for _, in := range []string{"600519", "600519.US", "sh600519", "AAAAAA.SH"} {
		if _, err := codeFor(in); err == nil {
			t.Fatalf("accepted %s", in)
		}
	}
}

func TestMappingUnitsAndNoInventedQuoteDate(t *testing.T) {
	k := &protocol.Kline{Open: 10000, High: 12000, Low: 9000, Close: 11000, Last: 10000,
		Volume: 123, Amount: 45678000, Time: time.Date(2026, 9, 18, 15, 0, 0, 0, time.UTC)}
	b := dailyRow("600519.SH", k, "stock")
	if b["close"] != float64(11) || b["volume"] != float64(123) || b["amount"] != float64(45678) {
		t.Fatal(b)
	}
	q := quoteRow(&protocol.Quote{Exchange: protocol.ExchangeSH, Code: "600519", Kline: k, ServerTime: "150000"})
	if q["timestamp"] != nil || q["last_price"] != float64(11) || q["volume"] != float64(123) {
		t.Fatal(q)
	}
	idx := dailyRow("000001.SH", k, "index")
	if idx["volume"] != float64(123) {
		t.Fatal(idx)
	} // Index daily decode already normalizes the wire value to hands.
}

func TestDepthMappingUsesHandsAndLocalReceiveTimestamp(t *testing.T) {
	k := &protocol.Kline{Close: 11000}
	q := &protocol.Quote{Exchange: protocol.ExchangeSH, Code: "600519", Kline: k, ServerTime: "150000"}
	for i := 0; i < 5; i++ {
		q.BuyLevel[i] = protocol.PriceLevel{Buy: true, Price: protocol.Price(10990 - int64(i*10)), Number: 10 + i}
		q.SellLevel[i] = protocol.PriceLevel{Price: protocol.Price(11010 + int64(i*10)), Number: 20 + i}
	}
	received := time.Date(2026, 9, 18, 15, 1, 2, 345000000, time.FixedZone("CST", 8*3600))
	row, err := depthRow(q, received)
	if err != nil {
		t.Fatal(err)
	}
	if row["symbol"] != "600519.SH" || row["timestamp"] != received.UnixMilli() ||
		row["timestamp_provenance"] != "local_receive" {
		t.Fatal(row)
	}
	bids := row["bid_volumes"].([5]int)
	asks := row["ask_volumes"].([5]int)
	if bids[0] != 10 || bids[4] != 14 || asks[0] != 20 || asks[4] != 24 {
		t.Fatal(row)
	}
	q.BuyLevel[0].Number = -1
	if _, err := depthRow(q, received); err == nil {
		t.Fatal("negative depth volume accepted")
	}
}

func TestAdjustmentFactorMappingMergeRangeAndFuture(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 9, d, 15, 0, 0, 0, time.Local) }
	events := []*protocol.Gbbq{
		{Code: "sh600519", Time: day(17), Category: 1, C1: 5}, // 10 shares dividend 5 yuan.
		{Code: "sh600519", Time: day(17), Category: 1, C3: 2}, // Same-day 10 shares bonus 2.
		{Code: "sh600519", Time: day(19), Category: 1, C1: 1}, // Announced, not effective yet.
	}
	bars := []*protocol.Kline{
		{Time: day(16), Close: 10000},
		{Time: day(17), Close: 8000},
		{Time: day(18), Close: 8100},
	}
	rows, err := adjFactorRows("600519.SH", events, bars, "2026-09-17", "2026-09-19")
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	// reference = round_half_up((10 - 0.5) / 1.2, 2) = 7.92.
	want := 10.0 / 7.92
	if rows[0]["trade_date"] != "2026-09-17" || math.Abs(rows[0]["ex_factor"].(float64)-want) > 1e-12 {
		t.Fatal(rows[0])
	}
	empty, err := adjFactorRows("600519.SH", events, bars, "2026-09-18", "2026-09-18")
	if err != nil || len(empty) != 0 {
		t.Fatalf("rows=%v err=%v", empty, err)
	}
}

func TestAdjustmentFactorRejectsMissingPreviousClose(t *testing.T) {
	day := time.Date(2026, 9, 17, 15, 0, 0, 0, time.Local)
	events := []*protocol.Gbbq{{Code: "sh600519", Time: day, Category: 1, C1: 5}}
	if _, err := adjFactorRows("600519.SH", events, []*protocol.Kline{{Time: day, Close: 9500}}, "", ""); err == nil {
		t.Fatal("missing previous close accepted")
	}
}

func TestAdjustmentFactorRoundsComponentsAndRejectsMissingAllotmentPrice(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 9, d, 15, 0, 0, 0, time.Local) }
	bars := []*protocol.Kline{{Time: day(16), Close: 10000}, {Time: day(17), Close: 9500}}
	rows, err := adjFactorRows(
		"600519.SH",
		[]*protocol.Gbbq{{Time: day(17), Category: 1, C1: 5.004}, {Time: day(17), Category: 1, C2: 3}},
		bars,
		"",
		"",
	)
	if err != nil || len(rows) != 1 || math.Abs(rows[0]["ex_factor"].(float64)-(10.0/9.5)) > 1e-12 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	_, err = adjFactorRows(
		"600519.SH",
		[]*protocol.Gbbq{{Time: day(17), Category: 1, C4: 2}},
		bars,
		"",
		"",
	)
	if err == nil {
		t.Fatal("allotment without price accepted")
	}
}

func TestMinuteMappingBeijingWallclockAndUnits(t *testing.T) {
	k := &protocol.Kline{Open: 10000, High: 10200, Low: 9900, Close: 10100,
		Volume: 123, Amount: 124230000, Time: time.Date(2026, 9, 18, 9, 31, 0, 0, time.Local)}
	row := minuteRow("600519.SH", k, "stock")
	if row["datetime"] != "2026-09-18T09:31:00" || row["close"] != float64(10.1) ||
		row["volume"] != float64(123) || row["amount"] != float64(124230) {
		t.Fatal(row)
	}
	idx := minuteRow("000001.SH", k, "index")
	if idx["volume"] != float64(1.23) {
		t.Fatal(idx)
	}
}

func TestMinutePaginationRangeAndBound(t *testing.T) {
	bar := func(day, minute int) *protocol.Kline {
		return &protocol.Kline{Time: time.Date(2026, 9, day, 9, minute, 0, 0, time.Local)}
	}
	calls := 0
	fetch := func(offset, count uint16) (*protocol.KlineResp, error) {
		calls++
		return &protocol.KlineResp{Count: 2, List: []*protocol.Kline{bar(18, 31), bar(18, 32)}}, nil
	}
	rows, err := readMinute(context.Background(), "600519.SH", "stock", "2026-09-18T09:32:00", "2026-09-18T09:32:00", fetch)
	if err != nil || len(rows) != 1 || calls != 1 {
		t.Fatalf("rows=%v calls=%d err=%v", rows, calls, err)
	}
	infinite := func(offset, count uint16) (*protocol.KlineResp, error) {
		return &protocol.KlineResp{Count: 800, List: []*protocol.Kline{bar(18, 31)}}, nil
	}
	if _, err := readMinute(context.Background(), "600519.SH", "stock", "", "", infinite); err == nil {
		t.Fatal("minute source bound ignored")
	}
}

func TestPaginationRangeEmptyAndBound(t *testing.T) {
	day := func(d int) *protocol.Kline {
		return &protocol.Kline{Time: time.Date(2026, 9, d, 15, 0, 0, 0, time.UTC)}
	}
	calls := 0
	fetch := func(offset, count uint16) (*protocol.KlineResp, error) {
		calls++
		if offset == 0 {
			return &protocol.KlineResp{Count: 800, List: []*protocol.Kline{day(17), day(18)}}, nil
		}
		return &protocol.KlineResp{}, nil
	}
	rows, err := readDaily(context.Background(), "600519.SH", "stock", "2026-09-18", "2026-09-18", fetch)
	if err != nil || len(rows) != 1 || calls != 1 {
		t.Fatalf("rows=%v calls=%d err=%v", rows, calls, err)
	}
	calls = 0
	_, err = readDaily(context.Background(), "600519.SH", "stock", "", "", fetch)
	if err != nil || calls != 2 {
		t.Fatal(calls, err)
	}
	infinite := func(offset, count uint16) (*protocol.KlineResp, error) {
		return &protocol.KlineResp{Count: 800, List: []*protocol.Kline{day(18)}}, nil
	}
	if _, err := readDaily(context.Background(), "600519.SH", "stock", "", "", infinite); err == nil {
		t.Fatal("page bound ignored")
	}
}

func TestInvalidRequest(t *testing.T) {
	b := &bridge{}
	for _, req := range []query{{Op: "unknown"}, {Op: "quotes"}, {Op: "depth5"}, {Op: "daily", Symbols: []string{"600519.SH"}, AssetType: "bond"}, {Op: "adj_factors", Symbols: []string{"600519.SH"}, AssetType: "etf"}} {
		if _, err := b.query(context.Background(), req); err == nil {
			t.Fatal(req)
		}
	}
}

func TestLiveTDXAdjustmentFactorAndDepth(t *testing.T) {
	if os.Getenv("TDX_LIVE_TEST") != "1" {
		t.Skip("set TDX_LIVE_TEST=1 to query public TDX servers")
	}
	hosts := tdx.Hosts
	if len(hosts) > 8 {
		hosts = hosts[:8]
	}
	b := &bridge{hosts: hosts, gate: make(chan struct{}, 1)}
	defer func() {
		if b.cli != nil {
			b.cli.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Second)
	defer cancel()
	rows, err := b.query(ctx, query{Op: "adj_factors", Symbols: []string{"600519.SH"}, AssetType: "stock", Start: "2024-01-01", End: time.Now().Format("2006-01-02")})
	if err != nil || len(rows) == 0 {
		t.Fatalf("live adjustment factors: rows=%v err=%v", rows, err)
	}
	for _, row := range rows {
		factor, ok := row["ex_factor"].(float64)
		if !ok || factor <= 0 || math.IsNaN(factor) || math.IsInf(factor, 0) {
			t.Fatalf("invalid live adjustment factor: %v", row)
		}
	}
	t.Logf("live adjustment factors: %v", rows)
	depth, err := b.query(ctx, query{Op: "depth5", Symbols: []string{"600519.SH"}})
	if err != nil || len(depth) != 1 {
		t.Fatalf("live depth: rows=%v err=%v", depth, err)
	}
	if depth[0]["timestamp_provenance"] != "local_receive" {
		t.Fatalf("invalid live depth timestamp: %v", depth[0])
	}
	t.Logf("live depth: %v", depth[0])
}
