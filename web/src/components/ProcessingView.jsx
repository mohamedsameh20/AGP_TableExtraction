export default function ProcessingView({ job }) {
  return (
    <div className="processing-view">
      <div className="spinner" />
      <h2>Processing <span className="gradient-text">{job.filename}</span></h2>
      <p>Running the 5-phase extraction pipeline...</p>

      <div className="pipeline-steps" style={{ marginTop: 8 }}>
        {[
          'Table Detection',
          'Structure Recognition',
          'Text Detection',
          'OCR Recognition',
          'Cell Assignment',
        ].map((label, i) => (
          <div className="pipeline-step" key={i} style={{
            borderColor: 'var(--border-accent)',
            animation: `pulse-badge ${1.5 + i * 0.2}s ease-in-out infinite`,
          }}>
            <span className="step-num">{i + 1}</span>
            {label}
          </div>
        ))}
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 16 }}>
        This typically takes 5–20 seconds depending on image complexity and hardware.
      </p>
    </div>
  )
}
