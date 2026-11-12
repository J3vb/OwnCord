package metrics

import (
	"bytes"
	"strconv"
	"strings"
)

// PromContentType is the text exposition (0.0.4) Content-Type; Prometheus 3 rejects a scrape type it cannot
// parse.
const PromContentType = "text/plain; version=0.0.4; charset=utf-8"

const (
	PromCounter   = "counter"
	PromGauge     = "gauge"
	PromHistogram = "histogram"
)

// PromLabel is one name="value" pair; names and values are constants matching
// [a-z0-9_]+ (a test pins that), so the writer does not escape them.
type PromLabel struct{ Name, Value string }

// PromText writes the Prometheus text exposition format by hand, so the default
// build needs no client library. The zero value is ready; not safe for
// concurrent use (one per scrape). Call Family, then its Sample or Histogram
// calls, then the next Family; the grammar test checks the order.
type PromText struct {
	buf    bytes.Buffer
	family string
}

// Bytes returns the text written so far.
func (p *PromText) Bytes() []byte { return p.buf.Bytes() }

var promHelpEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`)

// Family starts a metric family (HELP and TYPE lines); later calls belong to it.
func (p *PromText) Family(name, typ, help string) {
	p.family = name
	p.buf.WriteString("# HELP ")
	p.buf.WriteString(name)
	p.buf.WriteByte(' ')
	p.buf.WriteString(promHelpEscaper.Replace(help))
	p.buf.WriteString("\n# TYPE ")
	p.buf.WriteString(name)
	p.buf.WriteByte(' ')
	p.buf.WriteString(typ)
	p.buf.WriteByte('\n')
}

// Sample writes one sample of the current family.
func (p *PromText) Sample(labels []PromLabel, v float64) {
	p.line(p.family, labels, nil, v)
}

// Histogram writes one labelled histogram from raw counts: cumulative _bucket
// series, +Inf, _sum and _count, in seconds. Buckets, +Inf and _count come from
// one pass over the counters so +Inf == _count; _sum is a separate load and can
// differ by one in-flight observation, which Prometheus tolerates.
func (p *PromText) Histogram(labels []PromLabel, c Counts) {
	var cumulative uint64
	for i, bound := range latencyBoundsMs {
		cumulative += c.Buckets[i]
		le := PromLabel{Name: "le", Value: formatPromFloat(bound / 1000)}
		p.line(p.family+"_bucket", labels, &le, float64(cumulative))
	}
	cumulative += c.Buckets[len(latencyBoundsMs)]
	inf := PromLabel{Name: "le", Value: "+Inf"}
	p.line(p.family+"_bucket", labels, &inf, float64(cumulative))
	p.line(p.family+"_sum", labels, nil, float64(c.SumMicros)/1e6)
	p.line(p.family+"_count", labels, nil, float64(cumulative))
}

func (p *PromText) line(name string, labels []PromLabel, le *PromLabel, v float64) {
	p.buf.WriteString(name)
	if len(labels) > 0 || le != nil {
		p.buf.WriteByte('{')
		for i, l := range labels {
			if i > 0 {
				p.buf.WriteByte(',')
			}
			writePromLabel(&p.buf, l)
		}
		if le != nil {
			if len(labels) > 0 {
				p.buf.WriteByte(',')
			}
			writePromLabel(&p.buf, *le)
		}
		p.buf.WriteByte('}')
	}
	p.buf.WriteByte(' ')
	p.buf.WriteString(formatPromFloat(v))
	p.buf.WriteByte('\n')
}

func writePromLabel(b *bytes.Buffer, l PromLabel) {
	b.WriteString(l.Name)
	b.WriteString(`="`)
	b.WriteString(l.Value)
	b.WriteByte('"')
}

// formatPromFloat renders a value or bound; NaN and infinities come out as NaN, +Inf, -Inf.
func formatPromFloat(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
