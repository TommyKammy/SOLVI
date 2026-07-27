const q = async (p) => (await (await fetch('http://127.0.0.1:9090' + p)).json()).data;
const alerts = (await q('/api/v1/alerts')).alerts ?? [];
console.log('=== Prometheus 発火中 ===');
for (const a of alerts) console.log(a.labels.alertname, a.state, a.labels.severity, a.labels.job ?? '');
const sink = await (await fetch('http://127.0.0.1:9466/alerts')).json();
console.log('=== alert-sink 受信 ===', sink.length, '件');
for (const s of sink) console.log(s.receivedAt, s.status, s.alertname, s.severity, s.job ?? '');
