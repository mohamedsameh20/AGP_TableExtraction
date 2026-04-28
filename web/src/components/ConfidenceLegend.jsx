export default function ConfidenceLegend() {
  const stops = [
    { label: 'High', color: 'var(--confidence-high)', range: '≥ 0.85' },
    { label: 'Medium', color: 'var(--confidence-med)', range: '0.50 – 0.84' },
    { label: 'Low', color: 'var(--confidence-low)', range: '< 0.50' },
    { label: 'N/A', color: 'var(--confidence-none)', range: 'No score' },
  ]

  return (
    <div className="confidence-legend">
      <span className="confidence-legend-title">Confidence</span>
      {stops.map(s => (
        <div key={s.label} className="confidence-legend-item">
          <span className="confidence-dot" style={{ background: s.color }} />
          <span className="confidence-label">{s.label}</span>
          <span className="confidence-range">{s.range}</span>
        </div>
      ))}
    </div>
  )
}
